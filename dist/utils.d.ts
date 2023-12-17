/// <reference types="node" />
import { MapType } from "./types";
export declare const SERIALIZERS: {
    'application/json': {
        deserialize: (bytes: any, encoding: any) => any;
        serialize: (object: any) => Buffer;
    };
    'application/octet-stream': {
        deserialize: (bytes: any) => any;
        serialize: (bytes: any) => Buffer;
    };
    'text/plain': {
        deserialize: (bytes: any, encoding: any) => any;
        serialize: (str: string) => Buffer;
    };
};
export declare const mapify: <T>(list: T[], key: string | number) => MapType<T>;
export declare const wait: (time: any) => Promise<unknown>;
export declare function uniqueValue(): string;
