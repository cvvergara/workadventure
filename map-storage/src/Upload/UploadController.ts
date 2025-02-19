import * as fs from "fs";
import path from "node:path";
import { z, ZodError } from "zod";
import { Express } from "express";
import multer from "multer";
import pLimit from "p-limit";
import archiver from "archiver";
import StreamZip from "node-stream-zip";
import * as jsonpatch from "fast-json-patch";
import { MapValidator, OrganizedErrors } from "@workadventure/map-editor/src/GameMap/MapValidator";
import { WAMFileFormat } from "@workadventure/map-editor";
import { ZipFileFetcher } from "@workadventure/map-editor/src/GameMap/Validator/ZipFileFetcher";
import { HttpFileFetcher } from "@workadventure/map-editor/src/GameMap/Validator/HttpFileFetcher";
import { Operation } from "fast-json-patch";
import { generateErrorMessage } from "zod-error";
import { mapPath } from "../Services/PathMapper";
import { MAX_UNCOMPRESSED_SIZE } from "../Enum/EnvironmentVariable";
import { passportAuthenticator } from "../Services/Authentication";
import { mapsManager } from "../MapsManager";
import { uploadDetector } from "../Services/UploadDetector";
import { MapListService } from "../Services/MapListService";
import { FileSystemInterface } from "./FileSystemInterface";
import { FileNotFoundError } from "./FileNotFoundError";

const upload = multer({
    storage: multer.diskStorage({}),
    limits: {
        fileSize: MAX_UNCOMPRESSED_SIZE, // The compressed size cannot be bigger than the uncompressed size so it is safe to put this limit.
    },
});

export class UploadController {
    /**
     * A map containing a limiter. For a given directory, one cannot upload if another upload is in process.
     * This is not perfect (because we should actually forbid an upload on "/" if "/foo" is being uploaded), but it's
     * already a start of a check.
     */
    private uploadLimiter: Map<string, pLimit.Limit>;

    constructor(private app: Express, private fileSystem: FileSystemInterface, private mapListService: MapListService) {
        this.uploadLimiter = new Map<string, pLimit.Limit>();
        this.index();
        this.postUpload();
        this.putUpload();
        this.getDownload();
        this.move();
        this.copy();
        this.deleteDirectory();
        this.deleteFile();
        this.getMaps();
        this.patch();
    }

    private index() {
        this.app.get("/", passportAuthenticator, (req, res) => {
            res.sendFile(__dirname + "/index.html");
        });
    }

    private postUpload() {
        this.app.post("/upload", passportAuthenticator, upload.single("file"), (req, res, next) => {
            (async () => {
                // Make sure a file was uploaded
                if (!req.file) {
                    res.status(400).send("No file was uploaded.");
                    return;
                }

                // Get the uploaded file
                const zipFile = req.file;

                const Body = z.object({
                    directory: z.string().optional(),
                });

                const directory = Body.parse(req.body).directory || "";

                if (directory.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid directory");
                    return;
                }

                // Let's explicitly forbid 2 uploads from running at the same time using a p-limit of 1.
                // Uploads will be serialized.
                const virtualDirectory = mapPath(directory, req);
                let limiter = this.uploadLimiter.get(virtualDirectory);
                if (limiter === undefined) {
                    limiter = pLimit(1);
                    this.uploadLimiter.set(virtualDirectory, limiter);
                }

                await limiter(async () => {
                    // Read the contents of the ZIP archive
                    const zip = new StreamZip.async({ file: zipFile.path });
                    const zipEntries = Object.values(await zip.entries()).filter(
                        (zipEntry) => !zipEntry.isDirectory && this.filterFile(zipEntry.name)
                    );

                    let totalSize = 0;
                    for (const zipEntry of zipEntries) {
                        totalSize += zipEntry.size;
                    }

                    const availableFiles = zipEntries.map((entry) => entry.name);

                    if (totalSize > MAX_UNCOMPRESSED_SIZE) {
                        res.status(413).send(
                            `File too large. Unzipped files should be less than ${MAX_UNCOMPRESSED_SIZE} bytes.`
                        );
                        return;
                    }

                    const errors: { [key: string]: Partial<OrganizedErrors> } = {};

                    for (const zipEntry of zipEntries) {
                        // Let's validate the archive
                        const zipFileFetcher = new ZipFileFetcher(zipEntry.name, availableFiles);

                        const mapValidator = new MapValidator("error", zipFileFetcher);

                        const extension = path.extname(zipEntry.name);
                        if (
                            extension === ".json" &&
                            mapValidator.doesStringLooksLikeMap((await zip.entryData(zipEntry)).toString())
                        ) {
                            // We forbid Maps in JSON format.
                            errors[zipEntry.name] = {
                                map: [
                                    {
                                        type: "error",
                                        message: 'Invalid file extension. Maps should end with the ".tmj" extension.',
                                        details: "",
                                    },
                                ],
                            };

                            continue;
                        }
                        if (extension === ".wam") {
                            const result = mapValidator.validateWAMFile((await zip.entryData(zipEntry)).toString());
                            if (!result.ok) {
                                errors[zipEntry.name] = {
                                    map: [
                                        {
                                            type: "error",
                                            message: "Invalid WAM file format.",
                                            details: generateErrorMessage(result.error.issues ?? []),
                                        },
                                    ],
                                };
                            }
                            continue;
                        }

                        if (extension !== ".tmj") {
                            continue;
                        }

                        const result = await mapValidator.validateStringMap((await zip.entryData(zipEntry)).toString());
                        if (!result.ok) {
                            errors[zipEntry.name] = result.error;
                        }
                    }

                    if (Object.keys(errors).length > 0) {
                        res.status(400).json(errors);
                        return;
                    }

                    const filesPathsFromZip = zipEntries
                        .filter((zipEntry) => zipEntry.name.includes(".wam") || zipEntry.name.includes(".tmj"))
                        .map((zipEntry) => zipEntry.name);

                    // Delete all files in the given filesystem (disk or s3) with the exception of some .wam files
                    await this.fileSystem.deleteFilesExceptWAM(mapPath(directory, req), filesPathsFromZip);

                    const promises: Promise<void>[] = [];
                    const keysToPurge: string[] = [];
                    const wamFilesNames = zipEntries
                        .filter((zipEntry) => zipEntry.name.includes(".wam"))
                        .map((zipEntry) => path.parse(zipEntry.name).name);
                    // Iterate over the entries in the ZIP archive
                    for (const zipEntry of zipEntries) {
                        const key = mapPath(path.join(directory, zipEntry.name), req);
                        // Store the file
                        promises.push(this.fileSystem.writeFile(zipEntry, key, zip));
                        if (path.extname(key) === ".tmj") {
                            if (!wamFilesNames.includes(path.parse(zipEntry.name).name)) {
                                promises.push(this.createWAMFileIfMissing(key));
                            }
                        } else if (path.extname(key) === ".wam") {
                            keysToPurge.push(key);
                        }
                    }

                    await Promise.all(promises);

                    await zip.close();
                    // Delete the uploaded ZIP file from the disk
                    fs.unlink(zipFile.path, (err) => {
                        if (err) {
                            console.error("Error deleting file:", err);
                        }
                    });
                    for (const key of keysToPurge) {
                        mapsManager.clearAfterUpload(key);
                        uploadDetector.refresh(key);
                    }
                    await this.mapListService.generateCacheFile(req.hostname);

                    res.send("File successfully uploaded.");
                });

                if (limiter.activeCount === 0 && limiter.pendingCount === 0) {
                    this.uploadLimiter.delete(virtualDirectory);
                }
            })().catch((e) => next(e));
        });
    }

    private putUpload() {
        this.app.put("/*", passportAuthenticator, upload.single("file"), (req, res, next) => {
            (async () => {
                // Make sure a file was uploaded
                if (!req.file) {
                    res.status(400).send({
                        request: [
                            {
                                type: "error",
                                message: "No file was uploaded",
                                details: "",
                            },
                        ],
                    });
                    return;
                }

                // Get the uploaded file
                const file = req.file;

                const filePath = req.path;

                if (filePath.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid path");
                    return;
                }

                // Let's explicitly forbid 2 uploads from running at the same time using a p-limit of 1.
                // Uploads will be serialized.
                const virtualPath = mapPath(filePath, req);
                let limiter = this.uploadLimiter.get(filePath);
                if (limiter === undefined) {
                    limiter = pLimit(1);
                    this.uploadLimiter.set(virtualPath, limiter);
                }

                await limiter(async () => {
                    if (file.size > MAX_UNCOMPRESSED_SIZE) {
                        res.status(413).send(
                            `File too large. Files should be less than ${MAX_UNCOMPRESSED_SIZE} bytes.`
                        );
                        return;
                    }

                    // Let's validate the archive
                    const mapValidator = new MapValidator("error", new HttpFileFetcher(req.url));

                    let errors: Partial<OrganizedErrors> = {};

                    const content = await fs.promises.readFile(file.path, "utf8");

                    const extension = path.extname(filePath);
                    let wamFile: WAMFileFormat | undefined;
                    if (extension === ".json" && mapValidator.doesStringLooksLikeMap(content)) {
                        // We forbid Maps in JSON format.
                        errors = {
                            map: [
                                {
                                    type: "error",
                                    message: 'Invalid file extension. Maps should end with the ".tmj" extension.',
                                    details: "",
                                },
                            ],
                        };
                    } else if (extension === ".wam") {
                        const result = mapValidator.validateWAMFile(content);
                        if (!result.ok) {
                            errors = {
                                map: [
                                    {
                                        type: "error",
                                        message: "Invalid WAM file format.",
                                        details: generateErrorMessage(result.error.issues ?? []),
                                    },
                                ],
                            };
                        } else {
                            wamFile = result.value;
                        }
                    } else if (extension === ".tmj") {
                        const result = await mapValidator.validateStringMap(content);
                        if (!result.ok) {
                            errors = result.error;
                        }
                    }

                    if (Object.keys(errors).length > 0) {
                        res.status(400).json(errors);
                        return;
                    }

                    // TODO: create a "stream" version of this method to avoid loading the whole file in memory
                    await this.fileSystem.writeStringAsFile(virtualPath, content);

                    // Delete the uploaded file from the disk
                    fs.unlink(file.path, (err) => {
                        if (err) {
                            console.error("Error deleting file:", err);
                        }
                    });

                    if (extension === ".wam" && wamFile) {
                        mapsManager.clearAfterUpload(virtualPath);
                        uploadDetector.refresh(virtualPath);
                        await this.mapListService.updateWAMFileInCache(req.hostname, filePath, wamFile);
                    }

                    res.send("File successfully uploaded.");
                });

                if (limiter.activeCount === 0 && limiter.pendingCount === 0) {
                    this.uploadLimiter.delete(virtualPath);
                }
            })().catch((e) => next(e));
        });
    }

    private patch() {
        /**
         * This endpoint is used to patch aany WAM file using the JSON Patch notation.
         */
        this.app.patch("/*.wam", passportAuthenticator, (req, res, next) => {
            (async () => {
                const filePath = req.path;

                if (filePath.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid path");
                    return;
                }

                // Let's explicitly forbid 2 patches from running at the same time using a p-limit of 1.
                // Uploads will be serialized.
                const virtualPath = mapPath(filePath, req);
                let limiter = this.uploadLimiter.get(filePath);
                if (limiter === undefined) {
                    limiter = pLimit(1);
                    this.uploadLimiter.set(virtualPath, limiter);
                }

                await limiter(async () => {
                    const mapValidator = new MapValidator("error", new HttpFileFetcher(req.url));

                    let errors: Partial<OrganizedErrors> = {};

                    //eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    const content = JSON.parse(await this.fileSystem.readFileAsString(virtualPath));

                    //eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    const patchedContent = jsonpatch.applyPatch(
                        content,
                        req.body as Operation[],
                        true,
                        false
                    ).newDocument;

                    const patchedContentString = JSON.stringify(patchedContent);
                    const result = mapValidator.validateWAMFile(patchedContentString);
                    if (!result.ok) {
                        errors = {
                            map: [
                                {
                                    type: "error",
                                    message: "Invalid WAM file format.",
                                    details: generateErrorMessage(result.error.issues ?? []),
                                },
                            ],
                        };
                        res.status(400).json(errors);
                        return;
                    }

                    await this.fileSystem.writeStringAsFile(virtualPath, patchedContentString);

                    mapsManager.clearAfterUpload(virtualPath);
                    uploadDetector.refresh(virtualPath);

                    await this.mapListService.updateWAMFileInCache(req.hostname, filePath, result.value);

                    res.json({ success: true });
                });

                if (limiter.activeCount === 0 && limiter.pendingCount === 0) {
                    this.uploadLimiter.delete(virtualPath);
                }
            })().catch((e) => next(e));
        });
    }

    private async createWAMFileIfMissing(tmjKey: string): Promise<void> {
        const wamPath = tmjKey.slice().replace(".tmj", ".wam");
        if (!(await this.fileSystem.exist(wamPath))) {
            await this.fileSystem.writeStringAsFile(
                wamPath,
                JSON.stringify(this.getFreshWAMFileContent(`./${path.basename(tmjKey)}`), null, 4)
            );
        }
    }

    private getFreshWAMFileContent(tmjFilePath: string): WAMFileFormat {
        return {
            version: "1.0.0",
            mapUrl: tmjFilePath,
            areas: [],
            entities: [],
        };
    }

    /**
     * Let's filter out any file starting with "."
     */
    private filterFile(path: string): boolean {
        const paths = path.split(/[/\\]/);
        for (const subPath of paths) {
            if (subPath.startsWith(".")) {
                return false;
            }
        }
        return true;
    }

    private getDownload() {
        this.app.get("/download", passportAuthenticator, (req, res, next) => {
            (async () => {
                const directoryRaw = req.query.directory;
                const directory = z.string().optional().parse(directoryRaw) || "./";

                if (directory.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid directory");
                    return;
                }

                // Let's explicitly forbid 2 uploads from running at the same time using a p-limit of 1.
                // Uploads will be serialized.
                const virtualDirectory = mapPath(directory, req);

                let archiveName: string | undefined;
                if (directory) {
                    const baseName = path.basename(directory);
                    if (baseName !== "." && baseName !== "") {
                        archiveName = baseName + ".zip";
                    }
                }
                if (archiveName === undefined) {
                    archiveName = "map.zip";
                }

                res.attachment(archiveName);

                const archive = archiver("zip", {
                    zlib: { level: 9 }, // Sets the compression level.
                });

                // good practice to catch warnings (ie stat failures and other non-blocking errors)
                archive.on("warning", function (err) {
                    if (err.code === "ENOENT") {
                        // log warning
                        console.warn("File not found: ", err);
                    } else {
                        console.error("A warning occurred while Zipping file: ", err);
                    }
                });

                // good practice to catch this error explicitly
                archive.on("error", function (err) {
                    console.error("An error occurred while Zipping file: ", err);
                    res.status(500).send("An error occurred");
                });

                // pipe archive data to the file
                archive.pipe(res);

                await this.fileSystem.archiveDirectory(archive, virtualDirectory);

                await archive.finalize();
            })().catch((e) => next(e));
        });
    }

    private deleteDirectory() {
        this.app.delete("/delete", passportAuthenticator, (req, res, next) => {
            (async () => {
                const directoryRaw = req.query.directory;
                const directory = z.string().optional().parse(directoryRaw) || "./";

                if (directory.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid directory");
                    return;
                }

                const virtualDirectory = mapPath(directory, req);

                await this.fileSystem.deleteFiles(virtualDirectory);

                await this.mapListService.generateCacheFile(req.hostname);

                res.sendStatus(204);
            })().catch((e) => next(e));
        });
    }

    private deleteFile() {
        this.app.delete("/*", passportAuthenticator, (req, res, next) => {
            (async () => {
                const filePath = req.path;

                if (filePath.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid path");
                    return;
                }

                const virtualPath = mapPath(filePath, req);

                await this.fileSystem.deleteFiles(virtualPath);

                if (filePath.endsWith(".wam")) {
                    await this.mapListService.deleteWAMFileInCache(req.hostname, filePath);
                }

                res.sendStatus(204);
            })().catch((e) => next(e));
        });
    }

    private move() {
        this.app.post("/move", passportAuthenticator, (req, res, next) => {
            (async () => {
                const verifiedBody = z
                    .object({
                        source: z.string(),
                        destination: z.string(),
                    })
                    .safeParse(req.body);

                if (!verifiedBody.success) {
                    res.status(400).send("Invalid request :" + verifiedBody.error.message);
                    return;
                }

                const { source, destination } = verifiedBody.data;

                if (source.includes("..") || destination.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid directory");
                    return;
                }

                const virtualPath = mapPath(source, req);
                const newVirtualPath = mapPath(destination, req);

                if (await this.fileSystem.exist(newVirtualPath)) {
                    res.status(409).send("Destination already exist!");
                    return;
                }

                await this.fileSystem.move(virtualPath, newVirtualPath);
                await this.mapListService.generateCacheFile(req.hostname);
                res.sendStatus(200);
            })().catch((e) => next(e));
        });
    }

    private copy() {
        this.app.post("/copy", passportAuthenticator, (req, res, next) => {
            (async () => {
                const verifiedBody = z
                    .object({
                        source: z.string(),
                        destination: z.string(),
                    })
                    .safeParse(req.body);

                if (!verifiedBody.success) {
                    res.status(400).send("Invalid request :" + verifiedBody.error.message);
                    return;
                }

                const { source, destination } = verifiedBody.data;

                if (source.includes("..") || destination.includes("..")) {
                    // Attempt to override filesystem. That' a hack!
                    res.status(400).send("Invalid directory");
                    return;
                }

                const virtualPath = mapPath(source, req);
                const newVirtualPath = mapPath(destination, req);

                if (await this.fileSystem.exist(newVirtualPath)) {
                    res.status(409).send("Destination already exist!");
                    return;
                }

                await this.fileSystem.copy(virtualPath, newVirtualPath);
                await this.mapListService.generateCacheFile(req.hostname);
                res.sendStatus(201);
            })().catch((e) => next(e));
        });
    }

    private getMaps() {
        this.app.get("/maps", (req, res, next) => {
            (async () => {
                try {
                    const parsedCacheFile = await this.mapListService.readCacheFile(req.hostname);
                    res.json(parsedCacheFile);
                    return;
                } catch (e) {
                    if (e instanceof FileNotFoundError || e instanceof ZodError) {
                        // No cache file or invalid cache file? What the hell? Let's try to regenerate the cache file
                        await this.mapListService.generateCacheFile(req.hostname);
                        // Now that the cache file is generated, let's retry serving the file.
                        const parsedCacheFile = this.mapListService.readCacheFile(req.hostname);
                        res.json(parsedCacheFile);
                        return;
                    }
                    throw e;
                }
            })().catch((e) => next(e));
        });
    }
}
