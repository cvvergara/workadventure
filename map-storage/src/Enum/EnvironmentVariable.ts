import { EnvironmentVariables } from "./EnvironmentVariableValidator";

const envChecking = EnvironmentVariables.safeParse(process.env);

// Will break the process if an error happens
if (!envChecking.success) {
    console.error("\n\n\n-----------------------------------------");
    console.error("FATAL ERRORS FOUND IN ENVIRONMENT VARIABLES!!!");
    console.error("-----------------------------------------\n");

    const formattedError = envChecking.error.format();

    for (const [name, value] of Object.entries(formattedError)) {
        if (Array.isArray(value)) {
            continue;
        }

        for (const error of value._errors) {
            console.error(`For variable "${name}": ${error}`);
        }
    }

    console.error("\n-----------------------------------------\n\n\n");

    process.exit(1);
}

const env = envChecking.data;

export const AWS_ACCESS_KEY_ID = env.AWS_ACCESS_KEY_ID;
export const AWS_SECRET_ACCESS_KEY = env.AWS_SECRET_ACCESS_KEY;
export const AWS_DEFAULT_REGION = env.AWS_DEFAULT_REGION;
export const AWS_BUCKET = env.AWS_BUCKET;
export const AWS_URL = env.AWS_URL;
export const AWS_ENDPOINT = env.AWS_ENDPOINT;
//export const UPLOADER_AWS_SIGNED_URL_EXPIRATION = toNumber(env.UPLOADER_AWS_SIGNED_URL_EXPIRATION, 60);
export const S3_UPLOAD_CONCURRENCY_LIMIT = env.S3_UPLOAD_CONCURRENCY_LIMIT;
export const MAX_UNCOMPRESSED_SIZE = env.MAX_UNCOMPRESSED_SIZE;
export const USE_DOMAIN_NAME_IN_PATH = env.USE_DOMAIN_NAME_IN_PATH;
export const STORAGE_DIRECTORY = env.STORAGE_DIRECTORY;
// By default, cache only 10 seconds in the CDN
export const CACHE_CONTROL = env.CACHE_CONTROL;
export const WEB_HOOK_URL = env.WEB_HOOK_URL;
export const WEB_HOOK_API_TOKEN = env.WEB_HOOK_API_TOKEN;
export const ENV_VARS = env;
