import type { MapType, RabbitMqSerializer, RabbitMqSerializerMap } from "./types";

// https://github.com/Foo-Foo-MQ/foo-foo-mq/blob/main/src/index.js
export const SERIALIZERS: RabbitMqSerializerMap = {
  'application/json': {
    deserialize: (bytes: Buffer, encoding?: BufferEncoding) => {
      return JSON.parse(bytes.toString(encoding || 'utf8'));
    },
    serialize: (object: unknown) => {
      const json = (typeof object === 'string')
        ? object
        : JSON.stringify(object);
      return Buffer.from(json, 'utf8');
    }
  },
  'application/octet-stream': {
    deserialize: (bytes: Buffer) => {
      return bytes;
    },
    serialize: (bytes: unknown) => {
      if (Buffer.isBuffer(bytes)) {
        return bytes;
      } else if (Array.isArray(bytes)) {
        return Buffer.from(bytes);
      } else {
        throw new Error('Cannot serialize unknown data type');
      }
    }
  },
  'text/plain': {
    deserialize: (bytes: Buffer, encoding?: BufferEncoding) => {
      return bytes.toString(encoding || 'utf8');
    },
    serialize: (value: unknown) => {
      return Buffer.from(String(value), 'utf8');
    }
  }
};

export const registerSerializer = (contentType: string, serializer: RabbitMqSerializer) => {
  SERIALIZERS[contentType] = serializer;
  return serializer;
};

export const getSerializer = (contentType: string): RabbitMqSerializer | null => {
  return SERIALIZERS[contentType] || null;
};

export const mapify = <T extends object>(list: readonly T[], key: keyof T): MapType<T> => {
  return list.reduce((map: MapType<T>, item: T) => {
    map[String(item[key])] = item;
    return map;
  }, {} as MapType<T>);
};

export const wait = (time: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
};

export function uniqueValue() {
  return `${Math.random().toString(33).substring(2)}-${Date.now()}`;
}
