// https://github.com/Foo-Foo-MQ/foo-foo-mq/blob/main/src/index.js
export const SERIALIZERS = {
    'application/json': {
        deserialize: (bytes, encoding) => {
            return JSON.parse(bytes.toString(encoding || 'utf8'));
        },
        serialize: (object) => {
            const json = (typeof object === 'string')
                ? object
                : JSON.stringify(object);
            return Buffer.from(json, 'utf8');
        }
    },
    'application/octet-stream': {
        deserialize: (bytes) => {
            return bytes;
        },
        serialize: (bytes) => {
            if (Buffer.isBuffer(bytes)) {
                return bytes;
            }
            else if (Array.isArray(bytes)) {
                return Buffer.from(bytes);
            }
            else {
                throw new Error('Cannot serialize unknown data type');
            }
        }
    },
    'text/plain': {
        deserialize: (bytes, encoding) => {
            return bytes.toString(encoding || 'utf8');
        },
        serialize: (str) => {
            return Buffer.from(str, 'utf8');
        }
    }
};
export const mapify = (list, key) => {
    return list.reduce((map, item) => {
        map[item[key]] = item;
        return map;
    }, {});
};
export const wait = (time) => {
    return new Promise((resolve) => {
        setTimeout(resolve, time);
    });
};
export function uniqueValue() {
    return Math.random().toString(33).substring(2) + '-' + Date.now();
}
//# sourceMappingURL=utils.js.map