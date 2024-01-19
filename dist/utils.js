"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uniqueValue = exports.wait = exports.mapify = exports.SERIALIZERS = void 0;
// https://github.com/Foo-Foo-MQ/foo-foo-mq/blob/main/src/index.js
exports.SERIALIZERS = {
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
const mapify = (list, key) => {
    return list.reduce((map, item) => {
        map[item[key]] = item;
        return map;
    }, {});
};
exports.mapify = mapify;
const wait = (time) => {
    return new Promise((resolve) => {
        setTimeout(resolve, time);
    });
};
exports.wait = wait;
function uniqueValue() {
    return Math.random().toString(33).substring(2) + '-' + Date.now();
}
exports.uniqueValue = uniqueValue;
//# sourceMappingURL=utils.js.map