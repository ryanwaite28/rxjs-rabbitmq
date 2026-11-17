import { MapType, RabbitMqSerializer, RabbitMqSerializerMap } from "./types";
export declare const SERIALIZERS: RabbitMqSerializerMap;
export declare const registerSerializer: (contentType: string, serializer: RabbitMqSerializer) => RabbitMqSerializer;
export declare const getSerializer: (contentType: string) => RabbitMqSerializer;
export declare const mapify: <T>(list: T[], key: string | number) => MapType<T>;
export declare const wait: (time: any) => Promise<unknown>;
export declare function uniqueValue(): string;
