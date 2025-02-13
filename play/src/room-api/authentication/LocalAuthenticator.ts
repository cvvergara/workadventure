import { Status } from "@grpc/grpc-js/build/src/constants";
import { PUSHER_URL, ROOM_API_SECRET_KEY } from "../../pusher/enums/EnvironmentVariable";
import { GuardError } from "../types/GuardError";
import { AuthenticatorInterface } from "./AuthenticatorInterface";

const authenticator: AuthenticatorInterface = (apiKey, room) => {
    return new Promise((resolve, reject) => {
        if (apiKey !== ROOM_API_SECRET_KEY) {
            return reject(new GuardError(Status.UNAUTHENTICATED, "Wrong API key"));
        }

        if (PUSHER_URL !== "/" && !room.startsWith(PUSHER_URL)) {
            return reject(new GuardError(Status.PERMISSION_DENIED, "You cannot interact with this room!"));
        }

        return resolve();
    });
};

export default authenticator;
