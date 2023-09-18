import { MapType } from "./types";

// https://github.com/Foo-Foo-MQ/foo-foo-mq/blob/main/src/index.js
export const SERIALIZERS = {
  'application/json': {
    deserialize: (bytes: any, encoding: any) => {
      return JSON.parse(bytes.toString(encoding || 'utf8'));
    },
    serialize: (object: any) => {
      const json = (typeof object === 'string')
        ? object
        : JSON.stringify(object);
      return Buffer.from(json, 'utf8');
    }
  },
  'application/octet-stream': {
    deserialize: (bytes: any) => {
      return bytes;
    },
    serialize: (bytes: any) => {
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
    deserialize: (bytes: any, encoding: any) => {
      return bytes.toString(encoding || 'utf8');
    },
    serialize: (str: string) => {
      return Buffer.from(str, 'utf8');
    }
  }
};

export const mapify = <T> (list: T[], key: string | number): MapType<T> => {
  return list.reduce((map: MapType<T>, item: T) => {
    map[ item[key] ] = item;
    return map;
  }, {} as MapType<T>);
};

export const wait = (time) => {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
};

export function uniqueValue() {
  return Math.random().toString(33).substring(2) + '-' + Date.now();
}