#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createRequire as createRequire$1 } from "module";
import http2 from "node:http2";
import { execFileSync } from "node:child_process";

//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/env-utils-CGNazUNt.js
createRequire(import.meta.url);

//#endregion
//#region ../../node_modules/.pnpm/msgpackr@2.1.0/node_modules/msgpackr/unpack.js
var decoder;
try {
	decoder = new TextDecoder();
} catch (error) {}
var src;
var srcEnd;
var position$1 = 0;
const EMPTY_ARRAY = [];
var strings = EMPTY_ARRAY;
var stringPosition = 0;
var currentUnpackr = {};
var currentStructures;
var srcString;
var srcStringStart = 0;
var srcStringEnd = 0;
var bundledStrings$1;
var referenceMap;
var currentExtensions = [];
var dataView;
var defaultOptions = {
	useRecords: false,
	mapsAsObjects: true
};
var C1Type = class {};
const C1 = new C1Type();
C1.name = "MessagePack 0xC1";
var sequentialMode = false;
var inlineObjectReadThreshold = 2;
var Unpackr = class Unpackr {
	constructor(options) {
		if (options) {
			if (options.useRecords === false && options.mapsAsObjects === void 0) options.mapsAsObjects = true;
			if (options.sequential && options.trusted !== false) {
				options.trusted = true;
				if (!options.structures && options.useRecords != false) {
					options.structures = [];
					if (!options.maxSharedStructures) options.maxSharedStructures = 0;
				}
			}
			if (options.structures) options.structures.sharedLength = options.structures.length;
			else if (options.getStructures) {
				(options.structures = []).uninitialized = true;
				options.structures.sharedLength = 0;
			}
			if (options.int64AsNumber) options.int64AsType = "number";
		}
		Object.assign(this, options);
	}
	unpack(source, options) {
		if (src) return saveState(() => {
			clearSource();
			return this ? this.unpack(source, options) : Unpackr.prototype.unpack.call(defaultOptions, source, options);
		});
		if (!source.buffer && source.constructor === ArrayBuffer) source = typeof Buffer !== "undefined" ? Buffer.from(source) : new Uint8Array(source);
		if (typeof options === "object") {
			srcEnd = options.end || source.length;
			position$1 = options.start || 0;
		} else {
			position$1 = 0;
			srcEnd = options > -1 ? options : source.length;
		}
		stringPosition = 0;
		srcStringEnd = 0;
		srcString = null;
		strings = EMPTY_ARRAY;
		bundledStrings$1 = null;
		src = source;
		try {
			dataView = source.dataView || (source.dataView = new DataView(source.buffer, source.byteOffset, source.byteLength));
		} catch (error) {
			src = null;
			if (source instanceof Uint8Array) throw error;
			throw new Error("Source must be a Uint8Array or Buffer but was a " + (source && typeof source == "object" ? source.constructor.name : typeof source));
		}
		if (this instanceof Unpackr) {
			currentUnpackr = this;
			if (this.structures) {
				currentStructures = this.structures;
				return checkedRead(options);
			} else if (!currentStructures || currentStructures.length > 0) currentStructures = [];
		} else {
			currentUnpackr = defaultOptions;
			if (!currentStructures || currentStructures.length > 0) currentStructures = [];
		}
		return checkedRead(options);
	}
	unpackMultiple(source, forEach) {
		let values, lastPosition = 0;
		try {
			sequentialMode = true;
			let size = source.length;
			let value = this ? this.unpack(source, size) : defaultUnpackr.unpack(source, size);
			if (forEach) {
				if (forEach(value, lastPosition, position$1) === false) return;
				while (position$1 < size) {
					lastPosition = position$1;
					if (forEach(checkedRead(), lastPosition, position$1) === false) return;
				}
			} else {
				values = [value];
				while (position$1 < size) {
					lastPosition = position$1;
					values.push(checkedRead());
				}
				return values;
			}
		} catch (error) {
			error.lastPosition = lastPosition;
			error.values = values;
			throw error;
		} finally {
			sequentialMode = false;
			clearSource();
		}
	}
	_mergeStructures(loadedStructures, existingStructures) {
		if (this._onLoadedStructures) loadedStructures = this._onLoadedStructures(loadedStructures);
		loadedStructures = loadedStructures || [];
		if (Object.isFrozen(loadedStructures)) loadedStructures = loadedStructures.map((structure) => structure.slice(0));
		for (let i = 0, l = loadedStructures.length; i < l; i++) {
			let structure = loadedStructures[i];
			if (structure) {
				structure.isShared = true;
				if (i >= 32) structure.highByte = i - 32 >> 5;
			}
		}
		loadedStructures.sharedLength = loadedStructures.length;
		for (let id in existingStructures || []) if (id >= 0) {
			let structure = loadedStructures[id];
			let existing = existingStructures[id];
			if (existing) {
				if (structure) (loadedStructures.restoreStructures || (loadedStructures.restoreStructures = []))[id] = structure;
				loadedStructures[id] = existing;
			}
		}
		return this.structures = loadedStructures;
	}
	decode(source, options) {
		return this.unpack(source, options);
	}
};
function checkedRead(options) {
	try {
		if (!currentUnpackr.trusted && !sequentialMode) {
			let sharedLength = currentStructures.sharedLength || 0;
			if (sharedLength < currentStructures.length) currentStructures.length = sharedLength;
		}
		let result;
		if (currentUnpackr._readStruct && src[position$1] < 64 && src[position$1] >= 32) {
			result = currentUnpackr._readStruct(src, position$1, srcEnd);
			src = null;
			if (!(options && options.lazy) && result) result = result.toJSON();
			position$1 = srcEnd;
		} else result = read();
		if (bundledStrings$1) {
			position$1 = bundledStrings$1.postBundlePosition;
			bundledStrings$1 = null;
		}
		if (sequentialMode) currentStructures.restoreStructures = null;
		if (position$1 == srcEnd) {
			if (currentStructures && currentStructures.restoreStructures) restoreStructures();
			currentStructures = null;
			src = null;
			if (referenceMap) referenceMap = null;
		} else if (position$1 > srcEnd) throw new Error("Unexpected end of MessagePack data");
		else if (!sequentialMode) {
			let jsonView;
			try {
				jsonView = JSON.stringify(result, (_, value) => typeof value === "bigint" ? `${value}n` : value).slice(0, 100);
			} catch (error) {
				jsonView = "(JSON view not available " + error + ")";
			}
			throw new Error("Data read, but end of buffer not reached " + jsonView);
		}
		return result;
	} catch (error) {
		if (currentStructures && currentStructures.restoreStructures) restoreStructures();
		clearSource();
		if (error instanceof RangeError || error.message.startsWith("Unexpected end of buffer") || position$1 > srcEnd) error.incomplete = true;
		throw error;
	}
}
function restoreStructures() {
	for (let id in currentStructures.restoreStructures) currentStructures[id] = currentStructures.restoreStructures[id];
	currentStructures.restoreStructures = null;
}
function read() {
	let token = src[position$1++];
	if (token < 160) {
		if (token < 128) {
			if (token < 64) return token;
			else {
				let structure = currentStructures[token & 63] || currentUnpackr.getStructures && loadStructures()[token & 63];
				if (structure) {
					if (!structure.read) structure.read = createStructureReader(structure, token & 63);
					return structure.read();
				} else return token;
			}
		} else if (token < 144) {
			token -= 128;
			if (currentUnpackr.mapsAsObjects) {
				let object = {};
				for (let i = 0; i < token; i++) {
					let key = readKey();
					if (key === "__proto__") key = "__proto_";
					object[key] = read();
				}
				return object;
			} else {
				let map = /* @__PURE__ */ new Map();
				for (let i = 0; i < token; i++) map.set(read(), read());
				return map;
			}
		} else {
			token -= 144;
			let array = new Array(token);
			for (let i = 0; i < token; i++) array[i] = read();
			if (currentUnpackr.freezeData) return Object.freeze(array);
			return array;
		}
	} else if (token < 192) {
		let length = token - 160;
		if (srcStringEnd >= position$1) return srcString.slice(position$1 - srcStringStart, (position$1 += length) - srcStringStart);
		if (srcStringEnd == 0 && srcEnd < 140) {
			let string = length < 16 ? shortStringInJS(length) : longStringInJS(length);
			if (string != null) return string;
		}
		return readFixedString(length);
	} else {
		let value;
		switch (token) {
			case 192: return null;
			case 193:
				if (bundledStrings$1) {
					value = read();
					if (value > 0) return bundledStrings$1[1].slice(bundledStrings$1.position1, bundledStrings$1.position1 += value);
					else return bundledStrings$1[0].slice(bundledStrings$1.position0, bundledStrings$1.position0 -= value);
				}
				return C1;
			case 194: return false;
			case 195: return true;
			case 196:
				value = src[position$1++];
				if (value === void 0) throw new Error("Unexpected end of buffer");
				return readBin(value);
			case 197:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				return readBin(value);
			case 198:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				return readBin(value);
			case 199: return readExt(src[position$1++]);
			case 200:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				return readExt(value);
			case 201:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				return readExt(value);
			case 202:
				value = dataView.getFloat32(position$1);
				if (currentUnpackr.useFloat32 > 2) {
					let multiplier = mult10[(src[position$1] & 127) << 1 | src[position$1 + 1] >> 7];
					position$1 += 4;
					return (multiplier * value + (value > 0 ? .5 : -.5) >> 0) / multiplier;
				}
				position$1 += 4;
				return value;
			case 203:
				value = dataView.getFloat64(position$1);
				position$1 += 8;
				return value;
			case 204: return src[position$1++];
			case 205:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				return value;
			case 206:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				return value;
			case 207:
				if (currentUnpackr.int64AsType === "number") {
					value = dataView.getUint32(position$1) * 4294967296;
					value += dataView.getUint32(position$1 + 4);
				} else if (currentUnpackr.int64AsType === "string") value = dataView.getBigUint64(position$1).toString();
				else if (currentUnpackr.int64AsType === "auto") {
					value = dataView.getBigUint64(position$1);
					if (value <= BigInt(2) << BigInt(52)) value = Number(value);
				} else value = dataView.getBigUint64(position$1);
				position$1 += 8;
				return value;
			case 208: return dataView.getInt8(position$1++);
			case 209:
				value = dataView.getInt16(position$1);
				position$1 += 2;
				return value;
			case 210:
				value = dataView.getInt32(position$1);
				position$1 += 4;
				return value;
			case 211:
				if (currentUnpackr.int64AsType === "number") {
					value = dataView.getInt32(position$1) * 4294967296;
					value += dataView.getUint32(position$1 + 4);
				} else if (currentUnpackr.int64AsType === "string") value = dataView.getBigInt64(position$1).toString();
				else if (currentUnpackr.int64AsType === "auto") {
					value = dataView.getBigInt64(position$1);
					if (value >= BigInt(-2) << BigInt(52) && value <= BigInt(2) << BigInt(52)) value = Number(value);
				} else value = dataView.getBigInt64(position$1);
				position$1 += 8;
				return value;
			case 212:
				value = src[position$1++];
				if (value == 114) return recordDefinition(src[position$1++] & 63);
				else {
					let extension = currentExtensions[value];
					if (extension) {
						if (extension.read) {
							position$1++;
							return extension.read(read());
						} else if (extension.noBuffer) {
							position$1++;
							return extension();
						} else return extension(src.subarray(position$1, ++position$1));
					} else throw new Error("Unknown extension " + value);
				}
			case 213:
				value = src[position$1];
				if (value == 114) {
					position$1++;
					return recordDefinition(src[position$1++] & 63, src[position$1++]);
				} else return readExt(2);
			case 214: return readExt(4);
			case 215: return readExt(8);
			case 216: return readExt(16);
			case 217:
				value = src[position$1++];
				if (srcStringEnd >= position$1) return srcString.slice(position$1 - srcStringStart, (position$1 += value) - srcStringStart);
				return readString8(value);
			case 218:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				if (srcStringEnd >= position$1) return srcString.slice(position$1 - srcStringStart, (position$1 += value) - srcStringStart);
				return readString16(value);
			case 219:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				if (srcStringEnd >= position$1) return srcString.slice(position$1 - srcStringStart, (position$1 += value) - srcStringStart);
				return readString32(value);
			case 220:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				return readArray(value);
			case 221:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				return readArray(value);
			case 222:
				value = dataView.getUint16(position$1);
				position$1 += 2;
				return readMap(value);
			case 223:
				value = dataView.getUint32(position$1);
				position$1 += 4;
				return readMap(value);
			default:
				if (token >= 224) return token - 256;
				if (token === void 0) throw endOfMessagePackError();
				throw new Error("Unknown MessagePack token " + token);
		}
	}
}
const validName = /^[a-zA-Z_$][a-zA-Z\d_$]*$/;
function createStructureReader(structure, firstId) {
	function readObject() {
		if (readObject.count++ > inlineObjectReadThreshold) {
			let optimizedReadObject;
			try {
				optimizedReadObject = structure.read = new Function("r", "return function(){return " + (currentUnpackr.freezeData ? "Object.freeze" : "") + "({" + structure.map((key) => key === "__proto__" ? "__proto_:r()" : validName.test(key) ? key + ":r()" : "[" + JSON.stringify(key) + "]:r()").join(",") + "})}")(read);
			} catch (error) {
				inlineObjectReadThreshold = Infinity;
				return readObject();
			}
			structure.read0 = optimizedReadObject;
			if (structure.highByte === 0) structure.read = createSecondByteReader(firstId, structure.read);
			return optimizedReadObject();
		}
		let object = {};
		for (let i = 0, l = structure.length; i < l; i++) {
			let key = structure[i];
			if (key === "__proto__") key = "__proto_";
			object[key] = read();
		}
		if (currentUnpackr.freezeData) return Object.freeze(object);
		return object;
	}
	readObject.count = 0;
	structure.read0 = readObject;
	if (structure.highByte === 0) return createSecondByteReader(firstId, readObject);
	return readObject;
}
const createSecondByteReader = (firstId, read0) => {
	return function() {
		let highByte = src[position$1++];
		if (highByte === 0) return read0();
		let id = firstId < 32 ? -(firstId + (highByte << 5)) : firstId + (highByte << 5);
		let structure = currentStructures[id] || loadStructures()[id];
		if (!structure) throw new Error("Record id is not defined for " + id);
		if (!structure.read) structure.read = createStructureReader(structure, firstId);
		return structure.read();
	};
};
function loadStructures() {
	let loadedStructures = saveState(() => {
		src = null;
		return currentUnpackr.getStructures();
	});
	return currentStructures = currentUnpackr._mergeStructures(loadedStructures, currentStructures);
}
var readFixedString = readStringJS;
var readString8 = readStringJS;
var readString16 = readStringJS;
var readString32 = readStringJS;
let isNativeAccelerationEnabled = false;
function setExtractor(extractStrings) {
	isNativeAccelerationEnabled = true;
	readFixedString = readString(1);
	readString8 = readString(2);
	readString16 = readString(3);
	readString32 = readString(5);
	function readString(headerLength) {
		return function readString(length) {
			let string = strings[stringPosition++];
			if (string == null) {
				if (bundledStrings$1) return readStringJS(length);
				let byteOffset = src.byteOffset;
				let extraction = extractStrings(position$1 - headerLength + byteOffset, srcEnd + byteOffset, src.buffer);
				if (typeof extraction == "string") {
					string = extraction;
					strings = EMPTY_ARRAY;
				} else {
					strings = extraction;
					stringPosition = 1;
					srcStringEnd = 1;
					string = strings[0];
					if (string === void 0) throw new Error("Unexpected end of buffer");
				}
			}
			let srcStringLength = string.length;
			if (srcStringLength <= length) {
				position$1 += length;
				return string;
			}
			srcString = string;
			srcStringStart = position$1;
			srcStringEnd = position$1 + srcStringLength;
			position$1 += length;
			return string.slice(0, length);
		};
	}
}
function readStringJS(length) {
	let result;
	if (length < 16) {
		if (result = shortStringInJS(length)) return result;
	}
	if (length > 64 && decoder) return decoder.decode(src.subarray(position$1, position$1 += length));
	const end = position$1 + length;
	const units = [];
	result = "";
	while (position$1 < end) {
		const byte1 = src[position$1++];
		if ((byte1 & 128) === 0) units.push(byte1);
		else if ((byte1 & 224) === 192) {
			if (byte1 < 194 || position$1 >= end || (src[position$1] & 192) !== 128) units.push(65533);
			else {
				const byte2 = src[position$1++] & 63;
				units.push((byte1 & 31) << 6 | byte2);
			}
		} else if ((byte1 & 240) === 224) {
			const byte2 = position$1 < end ? src[position$1] : 0;
			if (position$1 >= end || (byte2 & 192) !== 128 || byte1 === 224 && byte2 < 160 || byte1 === 237 && byte2 >= 160) units.push(65533);
			else {
				position$1++;
				if (position$1 >= end || (src[position$1] & 192) !== 128) units.push(65533);
				else {
					const byte3 = src[position$1++] & 63;
					units.push((byte1 & 31) << 12 | (byte2 & 63) << 6 | byte3);
				}
			}
		} else if ((byte1 & 248) === 240) {
			const byte2 = position$1 < end ? src[position$1] : 0;
			if (byte1 > 244 || position$1 >= end || (byte2 & 192) !== 128 || byte1 === 240 && byte2 < 144 || byte1 === 244 && byte2 >= 144) units.push(65533);
			else {
				position$1++;
				if (position$1 >= end || (src[position$1] & 192) !== 128) units.push(65533);
				else {
					const byte3 = src[position$1++] & 63;
					if (position$1 >= end || (src[position$1] & 192) !== 128) units.push(65533);
					else {
						const byte4 = src[position$1++] & 63;
						let unit = (byte1 & 7) << 18 | (byte2 & 63) << 12 | byte3 << 6 | byte4;
						unit -= 65536;
						units.push(unit >>> 10 & 1023 | 55296);
						units.push(56320 | unit & 1023);
					}
				}
			}
		} else units.push(65533);
		if (units.length >= 4096) {
			result += fromCharCode.apply(String, units);
			units.length = 0;
		}
	}
	if (units.length > 0) result += fromCharCode.apply(String, units);
	return result;
}
function endOfMessagePackError() {
	let error = /* @__PURE__ */ new Error("Unexpected end of MessagePack data");
	error.incomplete = true;
	return error;
}
function readArray(length) {
	if (length > srcEnd - position$1) throw endOfMessagePackError();
	let array = new Array(length);
	for (let i = 0; i < length; i++) array[i] = read();
	if (currentUnpackr.freezeData) return Object.freeze(array);
	return array;
}
function readMap(length) {
	if (length > (srcEnd - position$1) / 2) throw endOfMessagePackError();
	if (currentUnpackr.mapsAsObjects) {
		let object = {};
		for (let i = 0; i < length; i++) {
			let key = readKey();
			if (key === "__proto__") key = "__proto_";
			object[key] = read();
		}
		return object;
	} else {
		let map = /* @__PURE__ */ new Map();
		for (let i = 0; i < length; i++) map.set(read(), read());
		return map;
	}
}
var fromCharCode = String.fromCharCode;
function longStringInJS(length) {
	let start = position$1;
	let bytes = new Array(length);
	for (let i = 0; i < length; i++) {
		const byte = src[position$1++];
		if ((byte & 128) > 0) {
			position$1 = start;
			return;
		}
		bytes[i] = byte;
	}
	return fromCharCode.apply(String, bytes);
}
function shortStringInJS(length) {
	if (length < 4) {
		if (length < 2) {
			if (length === 0) return "";
			else {
				let a = src[position$1++];
				if ((a & 128) > 1) {
					position$1 -= 1;
					return;
				}
				return fromCharCode(a);
			}
		} else {
			let a = src[position$1++];
			let b = src[position$1++];
			if ((a & 128) > 0 || (b & 128) > 0) {
				position$1 -= 2;
				return;
			}
			if (length < 3) return fromCharCode(a, b);
			let c = src[position$1++];
			if ((c & 128) > 0) {
				position$1 -= 3;
				return;
			}
			return fromCharCode(a, b, c);
		}
	} else {
		let a = src[position$1++];
		let b = src[position$1++];
		let c = src[position$1++];
		let d = src[position$1++];
		if ((a & 128) > 0 || (b & 128) > 0 || (c & 128) > 0 || (d & 128) > 0) {
			position$1 -= 4;
			return;
		}
		if (length < 6) {
			if (length === 4) return fromCharCode(a, b, c, d);
			else {
				let e = src[position$1++];
				if ((e & 128) > 0) {
					position$1 -= 5;
					return;
				}
				return fromCharCode(a, b, c, d, e);
			}
		} else if (length < 8) {
			let e = src[position$1++];
			let f = src[position$1++];
			if ((e & 128) > 0 || (f & 128) > 0) {
				position$1 -= 6;
				return;
			}
			if (length < 7) return fromCharCode(a, b, c, d, e, f);
			let g = src[position$1++];
			if ((g & 128) > 0) {
				position$1 -= 7;
				return;
			}
			return fromCharCode(a, b, c, d, e, f, g);
		} else {
			let e = src[position$1++];
			let f = src[position$1++];
			let g = src[position$1++];
			let h = src[position$1++];
			if ((e & 128) > 0 || (f & 128) > 0 || (g & 128) > 0 || (h & 128) > 0) {
				position$1 -= 8;
				return;
			}
			if (length < 10) {
				if (length === 8) return fromCharCode(a, b, c, d, e, f, g, h);
				else {
					let i = src[position$1++];
					if ((i & 128) > 0) {
						position$1 -= 9;
						return;
					}
					return fromCharCode(a, b, c, d, e, f, g, h, i);
				}
			} else if (length < 12) {
				let i = src[position$1++];
				let j = src[position$1++];
				if ((i & 128) > 0 || (j & 128) > 0) {
					position$1 -= 10;
					return;
				}
				if (length < 11) return fromCharCode(a, b, c, d, e, f, g, h, i, j);
				let k = src[position$1++];
				if ((k & 128) > 0) {
					position$1 -= 11;
					return;
				}
				return fromCharCode(a, b, c, d, e, f, g, h, i, j, k);
			} else {
				let i = src[position$1++];
				let j = src[position$1++];
				let k = src[position$1++];
				let l = src[position$1++];
				if ((i & 128) > 0 || (j & 128) > 0 || (k & 128) > 0 || (l & 128) > 0) {
					position$1 -= 12;
					return;
				}
				if (length < 14) {
					if (length === 12) return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l);
					else {
						let m = src[position$1++];
						if ((m & 128) > 0) {
							position$1 -= 13;
							return;
						}
						return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m);
					}
				} else {
					let m = src[position$1++];
					let n = src[position$1++];
					if ((m & 128) > 0 || (n & 128) > 0) {
						position$1 -= 14;
						return;
					}
					if (length < 15) return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m, n);
					let o = src[position$1++];
					if ((o & 128) > 0) {
						position$1 -= 15;
						return;
					}
					return fromCharCode(a, b, c, d, e, f, g, h, i, j, k, l, m, n, o);
				}
			}
		}
	}
}
function readOnlyJSString() {
	let token = src[position$1++];
	let length;
	if (token < 192) length = token - 160;
	else switch (token) {
		case 217:
			length = src[position$1++];
			break;
		case 218:
			length = dataView.getUint16(position$1);
			position$1 += 2;
			break;
		case 219:
			length = dataView.getUint32(position$1);
			position$1 += 4;
			break;
		default: throw new Error("Expected string");
	}
	return readStringJS(length);
}
function readBin(length) {
	return currentUnpackr.copyBuffers ? Uint8Array.prototype.slice.call(src, position$1, position$1 += length) : src.subarray(position$1, position$1 += length);
}
function readExt(length) {
	let type = src[position$1++];
	if (currentExtensions[type]) {
		let end;
		return currentExtensions[type](src.subarray(position$1, end = position$1 += length), (readPosition) => {
			position$1 = readPosition;
			try {
				return read();
			} finally {
				position$1 = end;
			}
		});
	} else throw new Error("Unknown extension type " + type);
}
var keyCache = new Array(4096);
function readKey() {
	let length = src[position$1++];
	if (length >= 160 && length < 192) {
		length = length - 160;
		if (srcStringEnd >= position$1) return srcString.slice(position$1 - srcStringStart, (position$1 += length) - srcStringStart);
		else if (!(srcStringEnd == 0 && srcEnd < 180)) return readFixedString(length);
	} else {
		position$1--;
		return asSafeString(read());
	}
	let key = (length << 5 ^ (length > 1 ? dataView.getUint16(position$1) : length > 0 ? src[position$1] : 0)) & 4095;
	let entry = keyCache[key];
	let checkPosition = position$1;
	let end = position$1 + length - 3;
	let chunk;
	let i = 0;
	if (entry && entry.bytes == length) {
		while (checkPosition < end) {
			chunk = dataView.getUint32(checkPosition);
			if (chunk != entry[i++]) {
				checkPosition = 1879048192;
				break;
			}
			checkPosition += 4;
		}
		end += 3;
		while (checkPosition < end) {
			chunk = src[checkPosition++];
			if (chunk != entry[i++]) {
				checkPosition = 1879048192;
				break;
			}
		}
		if (checkPosition === end) {
			position$1 = checkPosition;
			return entry.string;
		}
		end -= 3;
		checkPosition = position$1;
	}
	entry = [];
	keyCache[key] = entry;
	entry.bytes = length;
	while (checkPosition < end) {
		chunk = dataView.getUint32(checkPosition);
		entry.push(chunk);
		checkPosition += 4;
	}
	end += 3;
	while (checkPosition < end) {
		chunk = src[checkPosition++];
		entry.push(chunk);
	}
	let string = length < 16 ? shortStringInJS(length) : longStringInJS(length);
	if (string != null) return entry.string = string;
	return entry.string = readFixedString(length);
}
function asSafeString(property) {
	if (typeof property === "string") return property;
	if (typeof property === "number" || typeof property === "boolean" || typeof property === "bigint") return property.toString();
	if (property == null) return property + "";
	if (currentUnpackr.allowArraysInMapKeys && Array.isArray(property) && property.flat().every((item) => [
		"string",
		"number",
		"boolean",
		"bigint"
	].includes(typeof item))) return property.flat().toString();
	throw new Error(`Invalid property type for record: ${typeof property}`);
}
const recordDefinition = (id, highByte) => {
	let structure = read().map(asSafeString);
	let firstByte = id;
	if (highByte !== void 0) {
		id = id < 32 ? -((highByte << 5) + id) : (highByte << 5) + id;
		structure.highByte = highByte;
	}
	let existingStructure = currentStructures[id];
	if (existingStructure && (existingStructure.isShared || sequentialMode)) (currentStructures.restoreStructures || (currentStructures.restoreStructures = []))[id] = existingStructure;
	currentStructures[id] = structure;
	structure.read = createStructureReader(structure, firstByte);
	return (structure.read0 || structure.read)();
};
currentExtensions[0] = () => {};
currentExtensions[0].noBuffer = true;
currentExtensions[66] = (data) => {
	let headLength = data.byteLength % 8 || 8;
	let head = BigInt(data[0] & 128 ? data[0] - 256 : data[0]);
	for (let i = 1; i < headLength; i++) {
		head <<= BigInt(8);
		head += BigInt(data[i]);
	}
	if (data.byteLength !== headLength) {
		let view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		let decode = (start, end) => {
			let length = end - start;
			if (length <= 40) {
				let out = view.getBigUint64(start);
				for (let i = start + 8; i < end; i += 8) {
					out <<= BigInt(64);
					out |= view.getBigUint64(i);
				}
				return out;
			}
			let middle = start + (length >> 4 << 3);
			let left = decode(start, middle);
			let right = decode(middle, end);
			return left << BigInt((end - middle) * 8) | right;
		};
		head = head << BigInt((view.byteLength - headLength) * 8) | decode(headLength, view.byteLength);
	}
	return head;
};
let errors = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
	AggregateError: typeof AggregateError === "function" ? AggregateError : null
};
currentExtensions[101] = () => {
	let data = read();
	if (!errors[data[0]]) {
		let error = Error(data[1], { cause: data[2] });
		error.name = data[0];
		return error;
	}
	return errors[data[0]](data[1], { cause: data[2] });
};
currentExtensions[105] = (data) => {
	if (currentUnpackr.structuredClone === false) throw new Error("Structured clone extension is disabled");
	let id = dataView.getUint32(position$1 - 4);
	if (!referenceMap) referenceMap = /* @__PURE__ */ new Map();
	let token = src[position$1];
	let target;
	if (token >= 144 && token < 160 || token == 220 || token == 221) target = [];
	else if (token >= 128 && token < 144 || token == 222 || token == 223) target = /* @__PURE__ */ new Map();
	else if ((token >= 199 && token <= 201 || token >= 212 && token <= 216) && src[position$1 + 1] === 115) target = /* @__PURE__ */ new Set();
	else target = {};
	let refEntry = { target };
	referenceMap.set(id, refEntry);
	let targetProperties = read();
	if (!refEntry.used) return refEntry.target = targetProperties;
	else Object.assign(target, targetProperties);
	if (target instanceof Map) for (let [k, v] of targetProperties.entries()) target.set(k, v);
	if (target instanceof Set) for (let i of Array.from(targetProperties)) target.add(i);
	return target;
};
currentExtensions[112] = (data) => {
	if (currentUnpackr.structuredClone === false) throw new Error("Structured clone extension is disabled");
	let id = dataView.getUint32(position$1 - 4);
	let refEntry = referenceMap.get(id);
	refEntry.used = true;
	return refEntry.target;
};
currentExtensions[115] = () => new Set(read());
const typedArrays = [
	"Int8",
	"Uint8",
	"Uint8Clamped",
	"Int16",
	"Uint16",
	"Int32",
	"Uint32",
	"Float32",
	"Float64",
	"BigInt64",
	"BigUint64"
].map((type) => type + "Array");
let glbl = typeof globalThis === "object" ? globalThis : window;
currentExtensions[116] = (data) => {
	let typeCode = data[0];
	let buffer = Uint8Array.prototype.slice.call(data, 1).buffer;
	let typedArrayName = typedArrays[typeCode];
	if (!typedArrayName) {
		if (typeCode === 16) return buffer;
		if (typeCode === 17) return new DataView(buffer);
		throw new Error("Could not find typed array for code " + typeCode);
	}
	return new glbl[typedArrayName](buffer);
};
currentExtensions[120] = () => {
	let data = read();
	return new RegExp(data[0], data[1]);
};
const TEMP_BUNDLE = [];
currentExtensions[98] = (data) => {
	let dataSize = (data[0] << 24) + (data[1] << 16) + (data[2] << 8) + data[3];
	let dataPosition = position$1;
	position$1 += dataSize - data.length;
	bundledStrings$1 = TEMP_BUNDLE;
	bundledStrings$1 = [readOnlyJSString(), readOnlyJSString()];
	bundledStrings$1.position0 = 0;
	bundledStrings$1.position1 = 0;
	bundledStrings$1.postBundlePosition = position$1;
	position$1 = dataPosition;
	return read();
};
currentExtensions[255] = (data) => {
	if (data.length == 4) return /* @__PURE__ */ new Date((data[0] * 16777216 + (data[1] << 16) + (data[2] << 8) + data[3]) * 1e3);
	else if (data.length == 8) return /* @__PURE__ */ new Date(((data[0] << 22) + (data[1] << 14) + (data[2] << 6) + (data[3] >> 2)) / 1e6 + ((data[3] & 3) * 4294967296 + data[4] * 16777216 + (data[5] << 16) + (data[6] << 8) + data[7]) * 1e3);
	else if (data.length == 12) return /* @__PURE__ */ new Date(((data[0] << 24) + (data[1] << 16) + (data[2] << 8) + data[3]) / 1e6 + ((data[4] & 128 ? -281474976710656 : 0) + data[6] * 1099511627776 + data[7] * 4294967296 + data[8] * 16777216 + (data[9] << 16) + (data[10] << 8) + data[11]) * 1e3);
	else return /* @__PURE__ */ new Date("invalid");
};
function saveState(callback) {
	if (currentUnpackr && currentUnpackr._onSaveState) currentUnpackr._onSaveState();
	let savedSrcEnd = srcEnd;
	let savedPosition = position$1;
	let savedStringPosition = stringPosition;
	let savedSrcStringStart = srcStringStart;
	let savedSrcStringEnd = srcStringEnd;
	let savedSrcString = srcString;
	let savedStrings = strings;
	let savedReferenceMap = referenceMap;
	let savedBundledStrings = bundledStrings$1;
	let savedSrc = new Uint8Array(src.slice(0, srcEnd));
	let savedStructures = currentStructures;
	let savedStructuresContents = currentStructures.slice(0, currentStructures.length);
	let savedPackr = currentUnpackr;
	let savedSequentialMode = sequentialMode;
	let value = callback();
	srcEnd = savedSrcEnd;
	position$1 = savedPosition;
	stringPosition = savedStringPosition;
	srcStringStart = savedSrcStringStart;
	srcStringEnd = savedSrcStringEnd;
	srcString = savedSrcString;
	strings = savedStrings;
	referenceMap = savedReferenceMap;
	bundledStrings$1 = savedBundledStrings;
	src = savedSrc;
	sequentialMode = savedSequentialMode;
	currentStructures = savedStructures;
	currentStructures.splice(0, currentStructures.length, ...savedStructuresContents);
	currentUnpackr = savedPackr;
	dataView = new DataView(src.buffer, src.byteOffset, src.byteLength);
	return value;
}
function clearSource() {
	src = null;
	referenceMap = null;
	currentStructures = null;
}
const mult10 = new Array(147);
for (let i = 0; i < 256; i++) mult10[i] = +("1e" + Math.floor(45.15 - i * .30103));
var defaultUnpackr = new Unpackr({ useRecords: false });
const unpack = defaultUnpackr.unpack;
const unpackMultiple = defaultUnpackr.unpackMultiple;
const decode = defaultUnpackr.unpack;
const FLOAT32_OPTIONS = {
	NEVER: 0,
	ALWAYS: 1,
	DECIMAL_ROUND: 3,
	DECIMAL_FIT: 4
};
let f32Array = /* @__PURE__ */ new Float32Array(1);
let u8Array = new Uint8Array(f32Array.buffer, 0, 4);
Unpackr.SUPPORTS_STRUCT_HOOKS = true;

//#endregion
//#region ../../node_modules/.pnpm/msgpackr@2.1.0/node_modules/msgpackr/pack.js
let textEncoder;
try {
	textEncoder = new TextEncoder();
} catch (error) {}
let extensions;
let extensionClasses;
const hasNodeBuffer = typeof Buffer !== "undefined";
const ByteArrayAllocate = hasNodeBuffer ? function(length) {
	return Buffer.allocUnsafeSlow(length);
} : Uint8Array;
const ByteArray = hasNodeBuffer ? Buffer : Uint8Array;
const MAX_BUFFER_SIZE = hasNodeBuffer ? 4294967296 : 2144337920;
let target;
let keysTarget;
let targetView;
let position = 0;
let safeEnd;
let bundledStrings = null;
const MAX_BUNDLE_SIZE = 21760;
const hasNonLatin = /[\u0080-\uFFFF]/;
const RECORD_SYMBOL = Symbol("record-id");
var Packr = class extends Unpackr {
	constructor(options) {
		super(options);
		this.offset = 0;
		let start;
		let hasSharedUpdate;
		let structures;
		let referenceMap;
		let encodeUtf8 = ByteArray.prototype.utf8Write ? function(string, position) {
			return target.utf8Write(string, position, target.byteLength - position);
		} : textEncoder && textEncoder.encodeInto ? function(string, position) {
			return textEncoder.encodeInto(string, target.subarray(position)).written;
		} : false;
		let packr = this;
		if (!options) options = {};
		let isSequential = options && options.sequential;
		let hasSharedStructures = options.structures || options.saveStructures;
		let maxSharedStructures = options.maxSharedStructures;
		if (maxSharedStructures == null) maxSharedStructures = hasSharedStructures ? 32 : 0;
		if (maxSharedStructures > 8160) throw new Error("Maximum maxSharedStructure is 8160");
		if (options.structuredClone && options.moreTypes == void 0) this.moreTypes = true;
		let maxOwnStructures = options.maxOwnStructures;
		if (maxOwnStructures == null) maxOwnStructures = hasSharedStructures ? 32 : 64;
		if (!this.structures && options.useRecords != false) this.structures = [];
		let useTwoByteRecords = maxSharedStructures > 32 || maxOwnStructures + maxSharedStructures > 64;
		let sharedLimitId = maxSharedStructures + 64;
		let maxStructureId = maxSharedStructures + maxOwnStructures + 64;
		if (maxStructureId > 8256) throw new Error("Maximum maxSharedStructure + maxOwnStructure is 8192");
		let recordIdsToRemove = [];
		let transitionsCount = 0;
		let serializationsSinceTransitionRebuild = 0;
		this.pack = this.encode = function(value, encodeOptions) {
			if (!target) {
				target = new ByteArrayAllocate(8192);
				targetView = target.dataView || (target.dataView = new DataView(target.buffer, 0, 8192));
				position = 0;
			}
			safeEnd = target.length - 10;
			if (safeEnd - position < 2048) {
				target = new ByteArrayAllocate(target.length);
				targetView = target.dataView || (target.dataView = new DataView(target.buffer, 0, target.length));
				safeEnd = target.length - 10;
				position = 0;
			} else position = position + 7 & 2147483640;
			start = position;
			if (encodeOptions & 2048) position += encodeOptions & 255;
			referenceMap = packr.structuredClone ? /* @__PURE__ */ new Map() : null;
			if (packr.bundleStrings && typeof value !== "string") {
				bundledStrings = [];
				bundledStrings.size = Infinity;
			} else bundledStrings = null;
			structures = packr.structures;
			if (structures) {
				if (structures.uninitialized) structures = packr._mergeStructures(packr.getStructures());
				let sharedLength = structures.sharedLength || 0;
				if (sharedLength > maxSharedStructures) throw new Error("Shared structures is larger than maximum shared structures, try increasing maxSharedStructures to " + structures.sharedLength);
				if (!structures.transitions) {
					structures.transitions = Object.create(null);
					for (let i = 0; i < sharedLength; i++) {
						let keys = structures[i];
						if (!keys) continue;
						let nextTransition, transition = structures.transitions;
						for (let j = 0, l = keys.length; j < l; j++) {
							let key = keys[j];
							nextTransition = transition[key];
							if (!nextTransition) nextTransition = transition[key] = Object.create(null);
							transition = nextTransition;
						}
						transition[RECORD_SYMBOL] = i + 64;
					}
					this.lastNamedStructuresLength = sharedLength;
				}
				if (!isSequential) structures.nextId = sharedLength + 64;
			}
			if (hasSharedUpdate) hasSharedUpdate = false;
			let encodingError;
			try {
				if (packr._writeStruct && value && typeof value === "object") {
					if (value.constructor === Object) writeStruct(value);
					else if (value.constructor !== Map && !Array.isArray(value) && !extensionClasses.some((extClass) => value instanceof extClass)) writeStruct(packr.useToJSON !== false && value.toJSON ? value.toJSON() : value);
					else pack(value);
				} else pack(value);
				let lastBundle = bundledStrings;
				if (bundledStrings) writeBundles(start, pack, 0);
				if (referenceMap && referenceMap.idsToInsert) {
					let idsToInsert = referenceMap.idsToInsert.sort((a, b) => a.offset > b.offset ? 1 : -1);
					let i = idsToInsert.length;
					let incrementPosition = -1;
					while (lastBundle && i > 0) {
						let insertionPoint = idsToInsert[--i].offset + start;
						if (insertionPoint < lastBundle.stringsPosition + start && incrementPosition === -1) incrementPosition = 0;
						if (insertionPoint > lastBundle.position + start) {
							if (incrementPosition >= 0) incrementPosition += 6;
						} else {
							if (incrementPosition >= 0) {
								targetView.setUint32(lastBundle.position + start, targetView.getUint32(lastBundle.position + start) + incrementPosition);
								incrementPosition = -1;
							}
							lastBundle = lastBundle.previous;
							i++;
						}
					}
					if (incrementPosition >= 0 && lastBundle) targetView.setUint32(lastBundle.position + start, targetView.getUint32(lastBundle.position + start) + incrementPosition);
					position += idsToInsert.length * 6;
					if (position > safeEnd) makeRoom(position);
					packr.offset = position;
					let serialized = insertIds(target.subarray(start, position), idsToInsert);
					referenceMap = null;
					return serialized;
				}
				packr.offset = position;
				if (encodeOptions & 512) {
					target.start = start;
					target.end = position;
					return target;
				}
				return target.subarray(start, position);
			} catch (error) {
				encodingError = error;
				throw error;
			} finally {
				if (structures) {
					resetStructures();
					if (hasSharedUpdate && packr.saveStructures) {
						let sharedLength = structures.sharedLength || 0;
						let returnBuffer = target.subarray(start, position);
						let newSharedData = (packr._prepareStructures || prepareStructures)(structures, packr);
						if (!encodingError) {
							if (packr.saveStructures(newSharedData, newSharedData.isCompatible) === false) {
								structures.uninitialized = true;
								return packr.pack(value, encodeOptions);
							}
							packr.lastNamedStructuresLength = sharedLength;
							if (target.length > 1073741824) target = null;
							return returnBuffer;
						}
					}
				}
				if (target.length > 1073741824) target = null;
				if (encodeOptions & 1024) position = start;
			}
		};
		const resetStructures = () => {
			if (serializationsSinceTransitionRebuild < 10) serializationsSinceTransitionRebuild++;
			let sharedLength = structures.sharedLength || 0;
			if (structures.length > sharedLength && !isSequential) structures.length = sharedLength;
			if (transitionsCount > 1e4) {
				structures.transitions = null;
				serializationsSinceTransitionRebuild = 0;
				transitionsCount = 0;
				if (recordIdsToRemove.length > 0) recordIdsToRemove = [];
			} else if (recordIdsToRemove.length > 0 && !isSequential) {
				for (let i = 0, l = recordIdsToRemove.length; i < l; i++) recordIdsToRemove[i][RECORD_SYMBOL] = 0;
				recordIdsToRemove = [];
			}
		};
		const packArray = (value) => {
			var length = value.length;
			if (length < 16) target[position++] = 144 | length;
			else if (length < 65536) {
				target[position++] = 220;
				target[position++] = length >> 8;
				target[position++] = length & 255;
			} else {
				target[position++] = 221;
				targetView.setUint32(position, length);
				position += 4;
			}
			for (let i = 0; i < length; i++) pack(value[i]);
		};
		const pack = (value) => {
			if (position > safeEnd) target = makeRoom(position);
			var type = typeof value;
			var length;
			if (type === "string") {
				let strLength = value.length;
				if (bundledStrings && strLength >= 4 && strLength < 4096) {
					if ((bundledStrings.size += strLength) > MAX_BUNDLE_SIZE) {
						let extStart;
						let maxBytes = (bundledStrings[0] ? bundledStrings[0].length * 3 + bundledStrings[1].length : 0) + 10;
						if (position + maxBytes > safeEnd) target = makeRoom(position + maxBytes);
						let lastBundle;
						if (bundledStrings.position) {
							lastBundle = bundledStrings;
							target[position] = 200;
							position += 3;
							target[position++] = 98;
							extStart = position - start;
							position += 4;
							writeBundles(start, pack, 0);
							targetView.setUint16(extStart + start - 3, position - start - extStart);
						} else {
							target[position++] = 214;
							target[position++] = 98;
							extStart = position - start;
							position += 4;
						}
						bundledStrings = ["", ""];
						bundledStrings.previous = lastBundle;
						bundledStrings.size = 0;
						bundledStrings.position = extStart;
					}
					let twoByte = hasNonLatin.test(value);
					bundledStrings[twoByte ? 0 : 1] += value;
					target[position++] = 193;
					pack(twoByte ? -strLength : strLength);
					return;
				}
				let headerSize;
				if (strLength < 32) headerSize = 1;
				else if (strLength < 256) headerSize = 2;
				else if (strLength < 65536) headerSize = 3;
				else headerSize = 5;
				let maxBytes = strLength * 3;
				if (position + maxBytes > safeEnd) target = makeRoom(position + maxBytes);
				if (strLength < 64 || !encodeUtf8) {
					let i, c1, c2, strPosition = position + headerSize;
					for (i = 0; i < strLength; i++) {
						c1 = value.charCodeAt(i);
						if (c1 < 128) target[strPosition++] = c1;
						else if (c1 < 2048) {
							target[strPosition++] = c1 >> 6 | 192;
							target[strPosition++] = c1 & 63 | 128;
						} else if ((c1 & 64512) === 55296 && ((c2 = value.charCodeAt(i + 1)) & 64512) === 56320) {
							c1 = 65536 + ((c1 & 1023) << 10) + (c2 & 1023);
							i++;
							target[strPosition++] = c1 >> 18 | 240;
							target[strPosition++] = c1 >> 12 & 63 | 128;
							target[strPosition++] = c1 >> 6 & 63 | 128;
							target[strPosition++] = c1 & 63 | 128;
						} else {
							target[strPosition++] = c1 >> 12 | 224;
							target[strPosition++] = c1 >> 6 & 63 | 128;
							target[strPosition++] = c1 & 63 | 128;
						}
					}
					length = strPosition - position - headerSize;
				} else length = encodeUtf8(value, position + headerSize);
				if (length < 32) target[position++] = 160 | length;
				else if (length < 256) {
					if (headerSize < 2) target.copyWithin(position + 2, position + 1, position + 1 + length);
					target[position++] = 217;
					target[position++] = length;
				} else if (length < 65536) {
					if (headerSize < 3) target.copyWithin(position + 3, position + 2, position + 2 + length);
					target[position++] = 218;
					target[position++] = length >> 8;
					target[position++] = length & 255;
				} else {
					if (headerSize < 5) target.copyWithin(position + 5, position + 3, position + 3 + length);
					target[position++] = 219;
					targetView.setUint32(position, length);
					position += 4;
				}
				position += length;
			} else if (type === "number") {
				if (value >>> 0 === value) {
					if (value < 32 || value < 128 && this.useRecords === false || value < 64 && !this._writeStruct) target[position++] = value;
					else if (value < 256) {
						target[position++] = 204;
						target[position++] = value;
					} else if (value < 65536) {
						target[position++] = 205;
						target[position++] = value >> 8;
						target[position++] = value & 255;
					} else {
						target[position++] = 206;
						targetView.setUint32(position, value);
						position += 4;
					}
				} else if (value >> 0 === value) {
					if (value >= -32) target[position++] = 256 + value;
					else if (value >= -128) {
						target[position++] = 208;
						target[position++] = value + 256;
					} else if (value >= -32768) {
						target[position++] = 209;
						targetView.setInt16(position, value);
						position += 2;
					} else {
						target[position++] = 210;
						targetView.setInt32(position, value);
						position += 4;
					}
				} else {
					let useFloat32;
					if ((useFloat32 = this.useFloat32) > 0 && value < 4294967296 && value >= -2147483648) {
						target[position++] = 202;
						targetView.setFloat32(position, value);
						let xShifted;
						if (useFloat32 < 4 || (xShifted = value * mult10[(target[position] & 127) << 1 | target[position + 1] >> 7]) >> 0 === xShifted) {
							position += 4;
							return;
						} else position--;
					}
					target[position++] = 203;
					targetView.setFloat64(position, value);
					position += 8;
				}
			} else if (type === "object" || type === "function") {
				if (!value) target[position++] = 192;
				else {
					if (referenceMap) {
						let referee = referenceMap.get(value);
						if (referee) {
							if (!referee.id) referee.id = (referenceMap.idsToInsert || (referenceMap.idsToInsert = [])).push(referee);
							target[position++] = 214;
							target[position++] = 112;
							targetView.setUint32(position, referee.id);
							position += 4;
							return;
						} else referenceMap.set(value, { offset: position - start });
					}
					let constructor = value.constructor;
					if (constructor === Object) writeObject(value);
					else if (constructor === Array) packArray(value);
					else if (constructor === Map) {
						if (this.mapAsEmptyObject) target[position++] = 128;
						else {
							length = value.size;
							if (length < 16) target[position++] = 128 | length;
							else if (length < 65536) {
								target[position++] = 222;
								target[position++] = length >> 8;
								target[position++] = length & 255;
							} else {
								target[position++] = 223;
								targetView.setUint32(position, length);
								position += 4;
							}
							for (let [key, entryValue] of value) {
								pack(key);
								pack(entryValue);
							}
						}
					} else {
						for (let i = 0, l = extensions.length; i < l; i++) {
							let extensionClass = extensionClasses[i];
							if (value instanceof extensionClass) {
								let extension = extensions[i];
								if (extension.write) {
									if (extension.type) {
										target[position++] = 212;
										target[position++] = extension.type;
										target[position++] = 0;
									}
									let writeResult = extension.write.call(this, value);
									if (writeResult === value) {
										if (Array.isArray(value)) packArray(value);
										else writeObject(value);
									} else pack(writeResult);
									return;
								}
								let currentTarget = target;
								let currentTargetView = targetView;
								let currentPosition = position;
								target = null;
								let result;
								try {
									result = extension.pack.call(this, value, (size) => {
										target = currentTarget;
										currentTarget = null;
										position += size;
										if (position > safeEnd) makeRoom(position);
										return {
											target,
											targetView,
											position: position - size
										};
									}, pack);
								} finally {
									if (currentTarget) {
										target = currentTarget;
										targetView = currentTargetView;
										position = currentPosition;
										safeEnd = target.length - 10;
									}
								}
								if (result) {
									if (result.length + position > safeEnd) makeRoom(result.length + position);
									position = writeExtensionData(result, target, position, extension.type);
								}
								return;
							}
						}
						if (Array.isArray(value)) packArray(value);
						else {
							if (packr.useToJSON !== false && value.toJSON) {
								const json = value.toJSON();
								if (json !== value) return pack(json);
							}
							if (type === "function") return pack(this.writeFunction && this.writeFunction(value));
							writeObject(value);
						}
					}
				}
			} else if (type === "boolean") target[position++] = value ? 195 : 194;
			else if (type === "bigint") {
				if (value < 0x8000000000000000 && value >= -0x8000000000000000) {
					target[position++] = 211;
					targetView.setBigInt64(position, value);
				} else if (value < 0x10000000000000000 && value > 0) {
					target[position++] = 207;
					targetView.setBigUint64(position, value);
				} else if (this.largeBigIntToFloat) {
					target[position++] = 203;
					targetView.setFloat64(position, Number(value));
				} else if (this.largeBigIntToString) return pack(value.toString());
				else if (this.useBigIntExtension || this.moreTypes) {
					let empty = value < 0 ? BigInt(-1) : BigInt(0);
					let array;
					if (value >> BigInt(65536) === empty) {
						let mask = BigInt(0x10000000000000000) - BigInt(1);
						let chunks = [];
						while (true) {
							chunks.push(value & mask);
							if (value >> BigInt(63) === empty) break;
							value >>= BigInt(64);
						}
						array = new Uint8Array(new BigUint64Array(chunks).buffer);
						array.reverse();
					} else {
						let invert = value < 0;
						let string = (invert ? ~value : value).toString(16);
						if (string.length % 2) string = "0" + string;
						else if (parseInt(string.charAt(0), 16) >= 8) string = "00" + string;
						if (hasNodeBuffer) array = Buffer.from(string, "hex");
						else {
							array = new Uint8Array(string.length / 2);
							for (let i = 0; i < array.length; i++) array[i] = parseInt(string.slice(i * 2, i * 2 + 2), 16);
						}
						if (invert) for (let i = 0; i < array.length; i++) array[i] = ~array[i];
					}
					if (array.length + position > safeEnd) makeRoom(array.length + position);
					position = writeExtensionData(array, target, position, 66);
					return;
				} else throw new RangeError(value + " was too large to fit in MessagePack 64-bit integer format, use useBigIntExtension, or set largeBigIntToFloat to convert to float-64, or set largeBigIntToString to convert to string");
				position += 8;
			} else if (type === "undefined") {
				if (this.encodeUndefinedAsNil) target[position++] = 192;
				else {
					target[position++] = 212;
					target[position++] = 0;
					target[position++] = 0;
				}
			} else throw new Error("Unknown type: " + type);
		};
		const writePlainObject = this.variableMapSize || this.coercibleKeyAsNumber || this.skipValues ? (object) => {
			let keys;
			if (this.skipValues) {
				keys = [];
				for (let key in object) if ((typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) && !this.skipValues.includes(object[key])) keys.push(key);
			} else keys = Object.keys(object);
			let length = keys.length;
			if (length < 16) target[position++] = 128 | length;
			else if (length < 65536) {
				target[position++] = 222;
				target[position++] = length >> 8;
				target[position++] = length & 255;
			} else {
				target[position++] = 223;
				targetView.setUint32(position, length);
				position += 4;
			}
			let key;
			if (this.coercibleKeyAsNumber) for (let i = 0; i < length; i++) {
				key = keys[i];
				let num = Number(key);
				pack(isNaN(num) ? key : num);
				pack(object[key]);
			}
			else for (let i = 0; i < length; i++) {
				pack(key = keys[i]);
				pack(object[key]);
			}
		} : (object) => {
			target[position++] = 222;
			let objectOffset = position - start;
			position += 2;
			let size = 0;
			for (let key in object) if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
				pack(key);
				pack(object[key]);
				size++;
			}
			if (size > 65535) throw new Error("Object is too large to serialize with fast 16-bit map size, use the \"variableMapSize\" option to serialize this object");
			target[objectOffset++ + start] = size >> 8;
			target[objectOffset + start] = size & 255;
		};
		const writeRecord = this.useRecords === false ? writePlainObject : options.progressiveRecords && !useTwoByteRecords ? (object) => {
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null));
			let objectOffset = position++ - start;
			let wroteKeys;
			for (let key in object) if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
				nextTransition = transition[key];
				if (nextTransition) transition = nextTransition;
				else {
					let keys = Object.keys(object);
					let lastTransition = transition;
					transition = structures.transitions;
					let newTransitions = 0;
					for (let i = 0, l = keys.length; i < l; i++) {
						let key = keys[i];
						nextTransition = transition[key];
						if (!nextTransition) {
							nextTransition = transition[key] = Object.create(null);
							newTransitions++;
						}
						transition = nextTransition;
					}
					if (objectOffset + start + 1 == position) {
						position--;
						newRecord(transition, keys, newTransitions);
					} else insertNewRecord(transition, keys, objectOffset, newTransitions);
					wroteKeys = true;
					transition = lastTransition[key];
				}
				pack(object[key]);
			}
			if (!wroteKeys) {
				let recordId = transition[RECORD_SYMBOL];
				if (recordId) target[objectOffset + start] = recordId;
				else insertNewRecord(transition, Object.keys(object), objectOffset, 0);
			}
		} : (object) => {
			let nextTransition, transition = structures.transitions || (structures.transitions = Object.create(null));
			let newTransitions = 0;
			for (let key in object) if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) {
				nextTransition = transition[key];
				if (!nextTransition) {
					nextTransition = transition[key] = Object.create(null);
					newTransitions++;
				}
				transition = nextTransition;
			}
			let recordId = transition[RECORD_SYMBOL];
			if (recordId) {
				if (recordId >= 96 && useTwoByteRecords) {
					target[position++] = ((recordId -= 96) & 31) + 96;
					target[position++] = recordId >> 5;
				} else target[position++] = recordId;
			} else newRecord(transition, transition.__keys__ || Object.keys(object), newTransitions);
			for (let key in object) if (typeof object.hasOwnProperty !== "function" || object.hasOwnProperty(key)) pack(object[key]);
		};
		const checkUseRecords = typeof this.useRecords == "function" && this.useRecords;
		const writeObject = checkUseRecords ? (object) => {
			checkUseRecords(object) ? writeRecord(object) : writePlainObject(object);
		} : writeRecord;
		const writeStruct = (object) => {
			let newPosition = packr._writeStruct(object, target, start, position, structures, makeRoom, (value, newPosition, notifySharedUpdate) => {
				if (notifySharedUpdate) return hasSharedUpdate = true;
				position = newPosition;
				let startTarget = target;
				pack(value);
				resetStructures();
				if (startTarget !== target) return {
					position,
					targetView,
					target
				};
				return position;
			});
			if (newPosition === 0) return writeObject(object);
			position = newPosition;
		};
		const makeRoom = (end) => {
			let newSize;
			if (end > 16777216) {
				if (end - start > MAX_BUFFER_SIZE) throw new Error("Packed buffer would be larger than maximum buffer size");
				newSize = Math.min(MAX_BUFFER_SIZE, Math.round(Math.max((end - start) * (end > 67108864 ? 1.25 : 2), 4194304) / 4096) * 4096);
			} else newSize = (Math.max(end - start << 2, target.length - 1) >> 12) + 1 << 12;
			let newBuffer = new ByteArrayAllocate(newSize);
			targetView = newBuffer.dataView || (newBuffer.dataView = new DataView(newBuffer.buffer, 0, newSize));
			end = Math.min(end, target.length);
			if (target.copy) target.copy(newBuffer, 0, start, end);
			else newBuffer.set(target.slice(start, end));
			position -= start;
			start = 0;
			safeEnd = newBuffer.length - 10;
			return target = newBuffer;
		};
		const newRecord = (transition, keys, newTransitions) => {
			let recordId = structures.nextId;
			if (!recordId) recordId = 64;
			if (recordId < sharedLimitId && this.shouldShareStructure && !this.shouldShareStructure(keys)) {
				recordId = structures.nextOwnId;
				if (!(recordId < maxStructureId)) recordId = sharedLimitId;
				structures.nextOwnId = recordId + 1;
			} else {
				if (recordId >= maxStructureId) recordId = sharedLimitId;
				structures.nextId = recordId + 1;
			}
			let highByte = keys.highByte = recordId >= 96 && useTwoByteRecords ? recordId - 96 >> 5 : -1;
			transition[RECORD_SYMBOL] = recordId;
			transition.__keys__ = keys;
			structures[recordId - 64] = keys;
			if (recordId < sharedLimitId) {
				keys.isShared = true;
				structures.sharedLength = recordId - 63;
				hasSharedUpdate = true;
				if (highByte >= 0) {
					target[position++] = (recordId & 31) + 96;
					target[position++] = highByte;
				} else target[position++] = recordId;
			} else {
				if (highByte >= 0) {
					target[position++] = 213;
					target[position++] = 114;
					target[position++] = (recordId & 31) + 96;
					target[position++] = highByte;
				} else {
					target[position++] = 212;
					target[position++] = 114;
					target[position++] = recordId;
				}
				if (newTransitions) transitionsCount += serializationsSinceTransitionRebuild * newTransitions;
				if (recordIdsToRemove.length >= maxOwnStructures) recordIdsToRemove.shift()[RECORD_SYMBOL] = 0;
				recordIdsToRemove.push(transition);
				pack(keys);
			}
		};
		const insertNewRecord = (transition, keys, insertionOffset, newTransitions) => {
			let mainTarget = target;
			let mainPosition = position;
			let mainSafeEnd = safeEnd;
			let mainStart = start;
			target = keysTarget;
			position = 0;
			start = 0;
			if (!target) keysTarget = target = new ByteArrayAllocate(8192);
			safeEnd = target.length - 10;
			newRecord(transition, keys, newTransitions);
			keysTarget = target;
			let keysPosition = position;
			target = mainTarget;
			position = mainPosition;
			safeEnd = mainSafeEnd;
			start = mainStart;
			if (keysPosition > 1) {
				let newEnd = position + keysPosition - 1;
				if (newEnd > safeEnd) makeRoom(newEnd);
				let insertionPosition = insertionOffset + start;
				target.copyWithin(insertionPosition + keysPosition, insertionPosition + 1, position);
				target.set(keysTarget.slice(0, keysPosition), insertionPosition);
				position = newEnd;
			} else target[insertionOffset + start] = keysTarget[0];
		};
	}
	useBuffer(buffer) {
		target = buffer;
		target.dataView || (target.dataView = new DataView(target.buffer, target.byteOffset, target.byteLength));
		targetView = target.dataView;
		position = 0;
	}
	set position(value) {
		position = value;
	}
	get position() {
		return position;
	}
	clearSharedData() {
		if (this.structures) this.structures = [];
		if (this.typedStructs) this.typedStructs = [];
	}
};
extensionClasses = [
	Date,
	Set,
	Error,
	RegExp,
	ArrayBuffer,
	Object.getPrototypeOf(Uint8Array.prototype).constructor,
	DataView,
	C1Type
];
extensions = [
	{ pack(date, allocateForWrite, pack) {
		let seconds = date.getTime() / 1e3;
		if ((this.useTimestamp32 || date.getMilliseconds() === 0) && seconds >= 0 && seconds < 4294967296) {
			let { target, targetView, position } = allocateForWrite(6);
			target[position++] = 214;
			target[position++] = 255;
			targetView.setUint32(position, seconds);
		} else if (seconds > 0 && seconds < 4294967296) {
			let { target, targetView, position } = allocateForWrite(10);
			target[position++] = 215;
			target[position++] = 255;
			targetView.setUint32(position, date.getMilliseconds() * 4e6 + (seconds / 1e3 / 4294967296 >> 0));
			targetView.setUint32(position + 4, seconds);
		} else if (isNaN(seconds)) {
			if (this.onInvalidDate) {
				allocateForWrite(0);
				return pack(this.onInvalidDate());
			}
			let { target, targetView, position } = allocateForWrite(3);
			target[position++] = 212;
			target[position++] = 255;
			target[position++] = 255;
		} else {
			let { target, targetView, position } = allocateForWrite(15);
			target[position++] = 199;
			target[position++] = 12;
			target[position++] = 255;
			targetView.setUint32(position, date.getMilliseconds() * 1e6);
			targetView.setBigInt64(position + 4, BigInt(Math.floor(seconds)));
		}
	} },
	{ pack(set, allocateForWrite, pack) {
		if (this.setAsEmptyObject) {
			allocateForWrite(0);
			return pack({});
		}
		let array = Array.from(set);
		let { target, position } = allocateForWrite(this.moreTypes ? 3 : 0);
		if (this.moreTypes) {
			target[position++] = 212;
			target[position++] = 115;
			target[position++] = 0;
		}
		pack(array);
	} },
	{ pack(error, allocateForWrite, pack) {
		let { target, position } = allocateForWrite(this.moreTypes ? 3 : 0);
		if (this.moreTypes) {
			target[position++] = 212;
			target[position++] = 101;
			target[position++] = 0;
		}
		pack([
			error.name,
			error.message,
			error.cause
		]);
	} },
	{ pack(regex, allocateForWrite, pack) {
		let { target, position } = allocateForWrite(this.moreTypes ? 3 : 0);
		if (this.moreTypes) {
			target[position++] = 212;
			target[position++] = 120;
			target[position++] = 0;
		}
		pack([regex.source, regex.flags]);
	} },
	{ pack(arrayBuffer, allocateForWrite) {
		if (this.moreTypes) writeExtBuffer(arrayBuffer, 16, allocateForWrite);
		else writeBuffer(hasNodeBuffer ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer), allocateForWrite);
	} },
	{ pack(typedArray, allocateForWrite) {
		let constructor = typedArray.constructor;
		if (constructor !== ByteArray && this.moreTypes) writeExtBuffer(typedArray, typedArrays.indexOf(constructor.name), allocateForWrite);
		else writeBuffer(typedArray, allocateForWrite);
	} },
	{ pack(arrayBuffer, allocateForWrite) {
		if (this.moreTypes) writeExtBuffer(arrayBuffer, 17, allocateForWrite);
		else writeBuffer(hasNodeBuffer ? Buffer.from(arrayBuffer) : new Uint8Array(arrayBuffer), allocateForWrite);
	} },
	{ pack(c1, allocateForWrite) {
		let { target, position } = allocateForWrite(1);
		target[position] = 193;
	} }
];
function writeExtBuffer(typedArray, type, allocateForWrite, encode) {
	let length = typedArray.byteLength;
	if (length + 1 < 256) {
		var { target, position } = allocateForWrite(4 + length);
		target[position++] = 199;
		target[position++] = length + 1;
	} else if (length + 1 < 65536) {
		var { target, position } = allocateForWrite(5 + length);
		target[position++] = 200;
		target[position++] = length + 1 >> 8;
		target[position++] = length + 1 & 255;
	} else {
		var { target, position, targetView } = allocateForWrite(7 + length);
		target[position++] = 201;
		targetView.setUint32(position, length + 1);
		position += 4;
	}
	target[position++] = 116;
	target[position++] = type;
	if (!typedArray.buffer) typedArray = new Uint8Array(typedArray);
	target.set(new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength), position);
}
function writeBuffer(buffer, allocateForWrite) {
	let length = buffer.byteLength;
	var target, position;
	if (length < 256) {
		var { target, position } = allocateForWrite(length + 2);
		target[position++] = 196;
		target[position++] = length;
	} else if (length < 65536) {
		var { target, position } = allocateForWrite(length + 3);
		target[position++] = 197;
		target[position++] = length >> 8;
		target[position++] = length & 255;
	} else {
		var { target, position, targetView } = allocateForWrite(length + 5);
		target[position++] = 198;
		targetView.setUint32(position, length);
		position += 4;
	}
	target.set(buffer, position);
}
function writeExtensionData(result, target, position, type) {
	let length = result.length;
	switch (length) {
		case 1:
			target[position++] = 212;
			break;
		case 2:
			target[position++] = 213;
			break;
		case 4:
			target[position++] = 214;
			break;
		case 8:
			target[position++] = 215;
			break;
		case 16:
			target[position++] = 216;
			break;
		default: if (length < 256) {
			target[position++] = 199;
			target[position++] = length;
		} else if (length < 65536) {
			target[position++] = 200;
			target[position++] = length >> 8;
			target[position++] = length & 255;
		} else {
			target[position++] = 201;
			target[position++] = length >> 24;
			target[position++] = length >> 16 & 255;
			target[position++] = length >> 8 & 255;
			target[position++] = length & 255;
		}
	}
	target[position++] = type;
	target.set(result, position);
	position += length;
	return position;
}
function insertIds(serialized, idsToInsert) {
	let nextId;
	let distanceToMove = idsToInsert.length * 6;
	let lastEnd = serialized.length - distanceToMove;
	while (nextId = idsToInsert.pop()) {
		let offset = nextId.offset;
		let id = nextId.id;
		serialized.copyWithin(offset + distanceToMove, offset, lastEnd);
		distanceToMove -= 6;
		let position = offset + distanceToMove;
		serialized[position++] = 214;
		serialized[position++] = 105;
		serialized[position++] = id >> 24;
		serialized[position++] = id >> 16 & 255;
		serialized[position++] = id >> 8 & 255;
		serialized[position++] = id & 255;
		lastEnd = offset;
	}
	return serialized;
}
function writeBundles(start, pack, incrementPosition) {
	if (bundledStrings.length > 0) {
		targetView.setUint32(bundledStrings.position + start, position + incrementPosition - bundledStrings.position - start);
		bundledStrings.stringsPosition = position - start;
		let writeStrings = bundledStrings;
		bundledStrings = null;
		pack(writeStrings[0]);
		pack(writeStrings[1]);
	}
}
function prepareStructures(structures, packr) {
	structures.isCompatible = (existingStructures) => {
		let compatible = !existingStructures || (packr.lastNamedStructuresLength || 0) === existingStructures.length;
		if (!compatible) packr._mergeStructures(existingStructures);
		return compatible;
	};
	return structures;
}
Packr.SUPPORTS_STRUCT_HOOKS = true;
let defaultPackr = new Packr({ useRecords: false });
const pack = defaultPackr.pack;
const encode = defaultPackr.pack;
const { NEVER, ALWAYS, DECIMAL_ROUND, DECIMAL_FIT } = FLOAT32_OPTIONS;
const REUSE_BUFFER_MODE = 512;
const RESET_BUFFER_MODE = 1024;
const RESERVE_START_SPACE = 2048;

//#endregion
//#region ../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/process.js
var require_process = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const isLinux = () => process.platform === "linux";
	let report = null;
	const getReport = () => {
		if (!report) {
			/* istanbul ignore next */
			if (isLinux() && process.report) {
				const orig = process.report.excludeNetwork;
				process.report.excludeNetwork = true;
				report = process.report.getReport();
				process.report.excludeNetwork = orig;
			} else report = {};
		}
		return report;
	};
	module.exports = {
		isLinux,
		getReport
	};
}));

//#endregion
//#region ../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/filesystem.js
var require_filesystem = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const fs$1 = __require("fs");
	const LDD_PATH = "/usr/bin/ldd";
	const SELF_PATH = "/proc/self/exe";
	const MAX_LENGTH = 2048;
	/**
	* Read the content of a file synchronous
	*
	* @param {string} path
	* @returns {Buffer}
	*/
	const readFileSync = (path) => {
		const fd = fs$1.openSync(path, "r");
		const buffer = Buffer.alloc(MAX_LENGTH);
		const bytesRead = fs$1.readSync(fd, buffer, 0, MAX_LENGTH, 0);
		fs$1.close(fd, () => {});
		return buffer.subarray(0, bytesRead);
	};
	/**
	* Read the content of a file
	*
	* @param {string} path
	* @returns {Promise<Buffer>}
	*/
	const readFile = (path) => new Promise((resolve, reject) => {
		fs$1.open(path, "r", (err, fd) => {
			if (err) reject(err);
			else {
				const buffer = Buffer.alloc(MAX_LENGTH);
				fs$1.read(fd, buffer, 0, MAX_LENGTH, 0, (_, bytesRead) => {
					resolve(buffer.subarray(0, bytesRead));
					fs$1.close(fd, () => {});
				});
			}
		});
	});
	module.exports = {
		LDD_PATH,
		SELF_PATH,
		readFileSync,
		readFile
	};
}));

//#endregion
//#region ../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/elf.js
var require_elf = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const interpreterPath = (elf) => {
		if (elf.length < 64) return null;
		if (elf.readUInt32BE(0) !== 2135247942) return null;
		if (elf.readUInt8(4) !== 2) return null;
		if (elf.readUInt8(5) !== 1) return null;
		const offset = elf.readUInt32LE(32);
		const size = elf.readUInt16LE(54);
		const count = elf.readUInt16LE(56);
		for (let i = 0; i < count; i++) {
			const headerOffset = offset + i * size;
			if (elf.readUInt32LE(headerOffset) === 3) {
				const fileOffset = elf.readUInt32LE(headerOffset + 8);
				const fileSize = elf.readUInt32LE(headerOffset + 32);
				return elf.subarray(fileOffset, fileOffset + fileSize).toString().replace(/\0.*$/g, "");
			}
		}
		return null;
	};
	module.exports = { interpreterPath };
}));

//#endregion
//#region ../../node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc/lib/detect-libc.js
var require_detect_libc = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const childProcess = __require("child_process");
	const { isLinux, getReport } = require_process();
	const { LDD_PATH, SELF_PATH, readFile, readFileSync } = require_filesystem();
	const { interpreterPath } = require_elf();
	let cachedFamilyInterpreter;
	let cachedFamilyFilesystem;
	let cachedVersionFilesystem;
	const command = "getconf GNU_LIBC_VERSION 2>&1 || true; ldd --version 2>&1 || true";
	let commandOut = "";
	const safeCommand = () => {
		if (!commandOut) return new Promise((resolve) => {
			childProcess.exec(command, (err, out) => {
				commandOut = err ? " " : out;
				resolve(commandOut);
			});
		});
		return commandOut;
	};
	const safeCommandSync = () => {
		if (!commandOut) try {
			commandOut = childProcess.execSync(command, { encoding: "utf8" });
		} catch (_err) {
			commandOut = " ";
		}
		return commandOut;
	};
	/**
	* A String constant containing the value `glibc`.
	* @type {string}
	* @public
	*/
	const GLIBC = "glibc";
	/**
	* A Regexp constant to get the GLIBC Version.
	* @type {string}
	*/
	const RE_GLIBC_VERSION = /LIBC[a-z0-9 \-).]*?(\d+\.\d+)/i;
	/**
	* A String constant containing the value `musl`.
	* @type {string}
	* @public
	*/
	const MUSL = "musl";
	const isFileMusl = (f) => f.includes("libc.musl-") || f.includes("ld-musl-");
	const familyFromReport = () => {
		const report = getReport();
		if (report.header && report.header.glibcVersionRuntime) return GLIBC;
		if (Array.isArray(report.sharedObjects)) {
			if (report.sharedObjects.some(isFileMusl)) return MUSL;
		}
		return null;
	};
	const familyFromCommand = (out) => {
		const [getconf, ldd1] = out.split(/[\r\n]+/);
		if (getconf && getconf.includes(GLIBC)) return GLIBC;
		if (ldd1 && ldd1.includes(MUSL)) return MUSL;
		return null;
	};
	const familyFromInterpreterPath = (path) => {
		if (path) {
			if (path.includes("/ld-musl-")) return MUSL;
			else if (path.includes("/ld-linux-")) return GLIBC;
		}
		return null;
	};
	const getFamilyFromLddContent = (content) => {
		content = content.toString();
		if (content.includes("musl")) return MUSL;
		if (content.includes("GNU C Library")) return GLIBC;
		return null;
	};
	const familyFromFilesystem = async () => {
		if (cachedFamilyFilesystem !== void 0) return cachedFamilyFilesystem;
		cachedFamilyFilesystem = null;
		try {
			const lddContent = await readFile(LDD_PATH);
			cachedFamilyFilesystem = getFamilyFromLddContent(lddContent);
		} catch (e) {}
		return cachedFamilyFilesystem;
	};
	const familyFromFilesystemSync = () => {
		if (cachedFamilyFilesystem !== void 0) return cachedFamilyFilesystem;
		cachedFamilyFilesystem = null;
		try {
			const lddContent = readFileSync(LDD_PATH);
			cachedFamilyFilesystem = getFamilyFromLddContent(lddContent);
		} catch (e) {}
		return cachedFamilyFilesystem;
	};
	const familyFromInterpreter = async () => {
		if (cachedFamilyInterpreter !== void 0) return cachedFamilyInterpreter;
		cachedFamilyInterpreter = null;
		try {
			const selfContent = await readFile(SELF_PATH);
			const path = interpreterPath(selfContent);
			cachedFamilyInterpreter = familyFromInterpreterPath(path);
		} catch (e) {}
		return cachedFamilyInterpreter;
	};
	const familyFromInterpreterSync = () => {
		if (cachedFamilyInterpreter !== void 0) return cachedFamilyInterpreter;
		cachedFamilyInterpreter = null;
		try {
			const selfContent = readFileSync(SELF_PATH);
			const path = interpreterPath(selfContent);
			cachedFamilyInterpreter = familyFromInterpreterPath(path);
		} catch (e) {}
		return cachedFamilyInterpreter;
	};
	/**
	* Resolves with the libc family when it can be determined, `null` otherwise.
	* @returns {Promise<?string>}
	*/
	const family = async () => {
		let family = null;
		if (isLinux()) {
			family = await familyFromInterpreter();
			if (!family) {
				family = await familyFromFilesystem();
				if (!family) family = familyFromReport();
				if (!family) {
					const out = await safeCommand();
					family = familyFromCommand(out);
				}
			}
		}
		return family;
	};
	/**
	* Returns the libc family when it can be determined, `null` otherwise.
	* @returns {?string}
	*/
	const familySync = () => {
		let family = null;
		if (isLinux()) {
			family = familyFromInterpreterSync();
			if (!family) {
				family = familyFromFilesystemSync();
				if (!family) family = familyFromReport();
				if (!family) {
					const out = safeCommandSync();
					family = familyFromCommand(out);
				}
			}
		}
		return family;
	};
	/**
	* Resolves `true` only when the platform is Linux and the libc family is not `glibc`.
	* @returns {Promise<boolean>}
	*/
	const isNonGlibcLinux = async () => isLinux() && await family() !== GLIBC;
	/**
	* Returns `true` only when the platform is Linux and the libc family is not `glibc`.
	* @returns {boolean}
	*/
	const isNonGlibcLinuxSync = () => isLinux() && familySync() !== GLIBC;
	const versionFromFilesystem = async () => {
		if (cachedVersionFilesystem !== void 0) return cachedVersionFilesystem;
		cachedVersionFilesystem = null;
		try {
			const versionMatch = (await readFile(LDD_PATH)).match(RE_GLIBC_VERSION);
			if (versionMatch) cachedVersionFilesystem = versionMatch[1];
		} catch (e) {}
		return cachedVersionFilesystem;
	};
	const versionFromFilesystemSync = () => {
		if (cachedVersionFilesystem !== void 0) return cachedVersionFilesystem;
		cachedVersionFilesystem = null;
		try {
			const versionMatch = readFileSync(LDD_PATH).match(RE_GLIBC_VERSION);
			if (versionMatch) cachedVersionFilesystem = versionMatch[1];
		} catch (e) {}
		return cachedVersionFilesystem;
	};
	const versionFromReport = () => {
		const report = getReport();
		if (report.header && report.header.glibcVersionRuntime) return report.header.glibcVersionRuntime;
		return null;
	};
	const versionSuffix = (s) => s.trim().split(/\s+/)[1];
	const versionFromCommand = (out) => {
		const [getconf, ldd1, ldd2] = out.split(/[\r\n]+/);
		if (getconf && getconf.includes(GLIBC)) return versionSuffix(getconf);
		if (ldd1 && ldd2 && ldd1.includes(MUSL)) return versionSuffix(ldd2);
		return null;
	};
	/**
	* Resolves with the libc version when it can be determined, `null` otherwise.
	* @returns {Promise<?string>}
	*/
	const version = async () => {
		let version = null;
		if (isLinux()) {
			version = await versionFromFilesystem();
			if (!version) version = versionFromReport();
			if (!version) {
				const out = await safeCommand();
				version = versionFromCommand(out);
			}
		}
		return version;
	};
	/**
	* Returns the libc version when it can be determined, `null` otherwise.
	* @returns {?string}
	*/
	const versionSync = () => {
		let version = null;
		if (isLinux()) {
			version = versionFromFilesystemSync();
			if (!version) version = versionFromReport();
			if (!version) {
				const out = safeCommandSync();
				version = versionFromCommand(out);
			}
		}
		return version;
	};
	module.exports = {
		GLIBC,
		MUSL,
		family,
		familySync,
		isNonGlibcLinux,
		isNonGlibcLinuxSync,
		version,
		versionSync
	};
}));

//#endregion
//#region ../../node_modules/.pnpm/node-gyp-build-optional-packages@5.2.2/node_modules/node-gyp-build-optional-packages/node-gyp-build.js
var require_node_gyp_build = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var fs = __require("fs");
	var path = __require("path");
	var url = __require("url");
	var os = __require("os");
	var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
	var vars = process.config && process.config.variables || {};
	var prebuildsOnly = !!process.env.PREBUILDS_ONLY;
	var versions = process.versions;
	var abi = versions.modules;
	if (versions.deno || process.isBun) abi = "unsupported";
	var runtime = isElectron() ? "electron" : isNwjs() ? "node-webkit" : "node";
	var arch = process.env.npm_config_arch || os.arch();
	var platform = process.env.npm_config_platform || os.platform();
	var libc = process.env.LIBC || (isMusl(platform) ? "musl" : "glibc");
	var armv = process.env.ARM_VERSION || (arch === "arm64" ? "8" : vars.arm_version) || "";
	var uv = (versions.uv || "").split(".")[0];
	module.exports = load;
	function load(dir) {
		return runtimeRequire(load.resolve(dir));
	}
	load.resolve = load.path = function(dir) {
		dir = path.resolve(dir || ".");
		var packageName = "";
		var packageNameError;
		try {
			packageName = runtimeRequire(path.join(dir, "package.json")).name;
			var varName = packageName.toUpperCase().replace(/-/g, "_");
			if (process.env[varName + "_PREBUILD"]) dir = process.env[varName + "_PREBUILD"];
		} catch (err) {
			packageNameError = err;
		}
		if (!prebuildsOnly) {
			var release = getFirst(path.join(dir, "build/Release"), matchBuild);
			if (release) return release;
			var debug = getFirst(path.join(dir, "build/Debug"), matchBuild);
			if (debug) return debug;
		}
		var prebuild = resolve(dir);
		if (prebuild) return prebuild;
		var nearby = resolve(path.dirname(process.execPath));
		if (nearby) return nearby;
		var platformPackage = (packageName[0] == "@" ? "" : "@" + packageName + "/") + packageName + "-" + platform + "-" + arch;
		var packageResolutionError;
		try {
			return resolveFile(path.dirname(__require("module").createRequire(url.pathToFileURL(path.join(dir, "package.json"))).resolve(platformPackage)));
		} catch (error) {
			packageResolutionError = error;
		}
		let errMessage = "No native build was found for " + [
			"platform=" + platform,
			"arch=" + arch,
			"runtime=" + runtime,
			"abi=" + abi,
			"uv=" + uv,
			armv ? "armv=" + armv : "",
			"libc=" + libc,
			"node=" + process.versions.node,
			process.versions.electron ? "electron=" + process.versions.electron : "",
			typeof __webpack_require__ === "function" ? "webpack=true" : ""
		].filter(Boolean).join(" ") + "\n    attempted loading from: " + dir + " and package: " + platformPackage + "\n";
		if (packageNameError) errMessage += "Error finding package.json: " + packageNameError.message + "\n";
		if (packageResolutionError) errMessage += "Error resolving package: " + packageResolutionError.message + "\n";
		throw new Error(errMessage);
		function resolve(dir) {
			var tuple = readdirSync(path.join(dir, "prebuilds")).map(parseTuple).filter(matchTuple(platform, arch)).sort(compareTuples)[0];
			if (!tuple) return;
			return resolveFile(path.join(dir, "prebuilds", tuple.name));
		}
		function resolveFile(prebuilds) {
			var winner = readdirSync(prebuilds).map(parseTags).filter(matchTags(runtime, abi)).sort(compareTags(runtime))[0];
			if (winner) return path.join(prebuilds, winner.file);
		}
	};
	function readdirSync(dir) {
		try {
			return fs.readdirSync(dir);
		} catch (err) {
			return [];
		}
	}
	function getFirst(dir, filter) {
		var files = readdirSync(dir).filter(filter);
		return files[0] && path.join(dir, files[0]);
	}
	function matchBuild(name) {
		return /\.node$/.test(name);
	}
	function parseTuple(name) {
		var arr = name.split("-");
		if (arr.length !== 2) return;
		var platform = arr[0];
		var architectures = arr[1].split("+");
		if (!platform) return;
		if (!architectures.length) return;
		if (!architectures.every(Boolean)) return;
		return {
			name,
			platform,
			architectures
		};
	}
	function matchTuple(platform, arch) {
		return function(tuple) {
			if (tuple == null) return false;
			if (tuple.platform !== platform) return false;
			return tuple.architectures.includes(arch);
		};
	}
	function compareTuples(a, b) {
		return a.architectures.length - b.architectures.length;
	}
	function parseTags(file) {
		var arr = file.split(".");
		var extension = arr.pop();
		var tags = {
			file,
			specificity: 0
		};
		if (extension !== "node") return;
		for (var i = 0; i < arr.length; i++) {
			var tag = arr[i];
			if (tag === "node" || tag === "electron" || tag === "node-webkit") tags.runtime = tag;
			else if (tag === "napi") tags.napi = true;
			else if (tag.slice(0, 3) === "abi") tags.abi = tag.slice(3);
			else if (tag.slice(0, 2) === "uv") tags.uv = tag.slice(2);
			else if (tag.slice(0, 4) === "armv") tags.armv = tag.slice(4);
			else if (tag === "glibc" || tag === "musl") tags.libc = tag;
			else continue;
			tags.specificity++;
		}
		return tags;
	}
	function matchTags(runtime, abi) {
		return function(tags) {
			if (tags == null) return false;
			if (tags.runtime !== runtime && !runtimeAgnostic(tags)) return false;
			if (tags.abi !== abi && !tags.napi) return false;
			if (tags.uv && tags.uv !== uv) return false;
			if (tags.armv && tags.armv !== armv) return false;
			if (tags.libc && tags.libc !== libc) return false;
			return true;
		};
	}
	function runtimeAgnostic(tags) {
		return tags.runtime === "node" && tags.napi;
	}
	function compareTags(runtime) {
		return function(a, b) {
			if (a.runtime !== b.runtime) return a.runtime === runtime ? -1 : 1;
			else if (a.abi !== b.abi) return a.abi ? -1 : 1;
			else if (a.specificity !== b.specificity) return a.specificity > b.specificity ? -1 : 1;
			else return 0;
		};
	}
	function isNwjs() {
		return !!(process.versions && process.versions.nw);
	}
	function isElectron() {
		if (process.versions && process.versions.electron) return true;
		if (process.env.ELECTRON_RUN_AS_NODE) return true;
		return typeof window !== "undefined" && window.process && window.process.type === "renderer";
	}
	function isMusl(platform) {
		if (platform !== "linux") return false;
		const { familySync, MUSL } = require_detect_libc();
		return familySync() === MUSL;
	}
	load.parseTags = parseTags;
	load.matchTags = matchTags;
	load.compareTags = compareTags;
	load.parseTuple = parseTuple;
	load.matchTuple = matchTuple;
	load.compareTuples = compareTuples;
}));

//#endregion
//#region ../../node_modules/.pnpm/node-gyp-build-optional-packages@5.2.2/node_modules/node-gyp-build-optional-packages/index.js
var require_node_gyp_build_optional_packages = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
	if (typeof runtimeRequire.addon === "function") module.exports = runtimeRequire.addon.bind(runtimeRequire);
	else module.exports = require_node_gyp_build();
}));

//#endregion
//#region ../../node_modules/.pnpm/msgpackr-extract@3.0.4/node_modules/msgpackr-extract/index.js
var require_msgpackr_extract = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_node_gyp_build_optional_packages()(__dirname);
}));

//#endregion
//#region ../../node_modules/.pnpm/msgpackr@2.1.0/node_modules/msgpackr/node-index.js
if (!(process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED !== void 0 && process.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED.toLowerCase() === "true")) {
	let extractor;
	try {
		if (typeof __require == "function") extractor = require_msgpackr_extract();
		else extractor = createRequire$1(import.meta.url)("msgpackr-extract");
		if (extractor) setExtractor(extractor.extractStrings);
	} catch (error) {}
}

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/src-B6nsPVmD.js
createRequire(import.meta.url);
const DEFAULT_FILTER_WRITE_LIMITS = Object.freeze({
	maxMatch: 1e4,
	idsCap: 1e3
});
const sig = (name, args, returns, description) => ({
	name,
	args,
	returns,
	description
});
const CMP = "both sides the same type; int64 and number compare as number.";
const EXPR_FUNCTIONS = [
	sig("add", ["number", "number"], "any", "Sum; int64 when both are int64 (or a safe-integer literal), else number. Errors on overflow."),
	sig("sub", ["number", "number"], "any", "Difference; int64 when both are int64, else number. Errors on overflow."),
	sig("mul", ["number", "number"], "any", "Product; int64 when both are int64, else number. Errors on overflow, and on a nonzero product that underflows to zero."),
	sig("div", ["number", "number"], "number", "Quotient as a number; null when the divisor is zero. Errors on overflow, and on a nonzero quotient that underflows to zero."),
	sig("mod", ["int64", "int64"], "int64", "Remainder of int64 arguments (a safe-integer literal counts); null when the divisor is zero."),
	sig("neg", ["number"], "any", "Arithmetic negation; keeps int64."),
	sig("eq", ["any", "any"], "boolean", `Equal; ${CMP}`),
	sig("neq", ["any", "any"], "boolean", `Not equal; ${CMP}`),
	sig("gt", ["any", "any"], "boolean", `Greater than; ${CMP}`),
	sig("gte", ["any", "any"], "boolean", `Greater than or equal; ${CMP}`),
	sig("lt", ["any", "any"], "boolean", `Less than; ${CMP}`),
	sig("lte", ["any", "any"], "boolean", `Less than or equal; ${CMP}`),
	sig("and", "variadic", "boolean", "True when every boolean argument (one or more) is true."),
	sig("or", "variadic", "boolean", "True when any boolean argument (one or more) is true."),
	sig("not", ["boolean"], "boolean", "Boolean negation."),
	sig("isNull", ["any"], "boolean", "True when its one argument is null; any type."),
	sig("in", "variadic", "boolean", "True when the first argument equals any later one (two or more arguments share a type)."),
	sig("length", ["string"], "number", "Length in characters."),
	sig("lower", ["string"], "string", "Lower-cased text; ASCII letters only, every other character is unchanged."),
	sig("upper", ["string"], "string", "Upper-cased text; ASCII letters only, every other character is unchanged."),
	sig("substring", [
		"string",
		"number",
		"number"
	], "string", "Substring from a 1-based start for a length."),
	sig("concat", "variadic", "string", "Concatenation of one or more string arguments."),
	sig("like", ["string", "likePattern"], "boolean", "SQL LIKE, case-sensitive: % and _ wildcards, backslash escape. The pattern is a lit that does not end in an unescaped backslash."),
	sig("notLike", ["string", "likePattern"], "boolean", "Negated SQL LIKE, case-sensitive."),
	sig("regexpMatch", ["string", "pattern"], "boolean", "True when the portable-subset regex (a lit) matches anywhere."),
	sig("regexpReplace", [
		"string",
		"pattern",
		"string"
	], "string", "Replace the leftmost-longest regex (a lit) match; the replacement may use \\1 to \\9. The pattern may use capturing groups or |, not both."),
	sig("dateTrunc", ["unit", "date"], "date", "Truncate a date (UTC) to a unit given as a lit."),
	sig("extract", ["unit", "date"], "number", "A date part (UTC) as a number; the unit is a lit."),
	sig("case", "variadic", "any", "Pairs [cond, then] then a final else; branches share a type."),
	sig("coalesce", "variadic", "any", "First non-null of one or more arguments sharing a type.")
];
/** Natural order of a type that declares none: newest first. */
const DEFAULT_ORDERED_BY = Object.freeze({ createdAt: "desc" });
/**
* Inbound frames come from untrusted peers: structured-clone references (and
* so cyclic values) are refused. `mapsAsObjects` keeps the default `unpack`'s
* plain-object maps. msgpackr's other built-in extensions are process-global
* and still decode, so a server checks a request with `isPlainRequestData`.
*/
const inbound = new Unpackr({
	structuredClone: false,
	mapsAsObjects: true
});
const utf8 = new TextEncoder();

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/src-D3ACIp1y.js
createRequire(import.meta.url);

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/src-B_oTGi3X.js
createRequire(import.meta.url);
let current = (input, init) => globalThis.fetch(input, init);
const substrateFetch = (input, init) => current(input, init);
/** Replace what `substrateFetch` calls. The Node entry and test setups use it. */
function setSubstrateFetch(fetch) {
	current = fetch;
}
/**
* A fetch-shaped function over `node:http2`: the transport seam's HTTP/2
* adapter for Node and Bun (Todo #1850, Decision #625).
*
* One `ClientHttp2Session` per origin, opened on first use and shared by every
* request to it; concurrent first calls share the pending connect. A session is
* dropped on GOAWAY, close or error, and the next request opens a new one. An
* idle session is unref'd, so a short-lived process exits without `close()`.
* `http:` origins use HTTP/2 with prior knowledge (h2c); `https:` origins verify
* the server against `ca`, or the process's default trust (which includes
* NODE_EXTRA_CA_CERTS). Certificate checks are never turned off.
*
* Imports node builtins only.
*/
const DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
/** Request headers HTTP/2 forbids (RFC 9113 §8.2.2); fetch callers may still set them. */
const CONNECTION_HEADERS = /* @__PURE__ */ new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"upgrade",
	"proxy-connection",
	"host"
]);
function abortError(signal) {
	const reason = signal.reason;
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	return new DOMException("This operation was aborted", "AbortError");
}
function toHeaderRecord(init) {
	const out = {};
	new Headers(init).forEach((value, name) => {
		if (!CONNECTION_HEADERS.has(name)) out[name] = value;
	});
	return out;
}
function toBodyBytes(body) {
	if (body === void 0 || body === null) return void 0;
	if (typeof body === "string" || body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	throw new TypeError("createH2Fetch: only string, ArrayBuffer and typed-array bodies are supported");
}
function createH2Fetch(opts = {}) {
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	const pool = /* @__PURE__ */ new Map();
	/** Every session opened, connected or not, so close() can end them all. */
	const sessions = /* @__PURE__ */ new Set();
	function connect(origin) {
		const existing = pool.get(origin);
		if (existing !== void 0) return existing;
		const pending = new Promise((resolve, reject) => {
			const session = http2.connect(origin, origin.startsWith("https:") && opts.ca !== void 0 ? { ca: opts.ca } : {});
			sessions.add(session);
			session.once("close", () => sessions.delete(session));
			const pooled = {
				session,
				holds: 0
			};
			let connected = false;
			const drop = () => {
				if (pool.get(origin) === pending) pool.delete(origin);
			};
			const fail = (err) => {
				clearTimeout(timer);
				drop();
				if (!connected) reject(err);
			};
			const timer = setTimeout(() => {
				session.destroy();
				fail(/* @__PURE__ */ new Error(`connect to ${origin} timed out after ${connectTimeoutMs} ms`));
			}, connectTimeoutMs);
			timer.unref();
			session.once("connect", () => {
				clearTimeout(timer);
				connected = true;
				session.unref();
				resolve(pooled);
			});
			session.on("error", fail);
			session.on("goaway", drop);
			session.on("close", () => fail(/* @__PURE__ */ new Error(`connection to ${origin} closed before it opened`)));
		});
		pending.catch(() => {});
		pool.set(origin, pending);
		return pending;
	}
	/** Forget `pooled` if it is still the origin's session, so the next request opens a new one. */
	function forget(origin, pooled) {
		const current = pool.get(origin);
		if (current === void 0) return;
		current.then((p) => {
			if (p === pooled && pool.get(origin) === current) pool.delete(origin);
		}, () => {});
	}
	const fetchH2 = async (input, init = {}) => {
		const signal = init.signal ?? void 0;
		if (signal?.aborted) throw abortError(signal);
		const url = new URL(input);
		const body = toBodyBytes(init.body);
		const headers = {
			...toHeaderRecord(init.headers),
			":method": (init.method ?? "GET").toUpperCase(),
			":path": `${url.pathname}${url.search}`
		};
		for (let attempt = 0;; attempt++) {
			const pooled = await untilAborted(connect(url.origin), signal);
			const outcome = await send(pooled, headers, body, init, signal);
			if (outcome.kind === "response") return outcome.response;
			forget(url.origin, pooled);
			if (outcome.kind === "retry" && attempt === 0) continue;
			throw outcome.error;
		}
	};
	return Object.assign(fetchH2, { async close() {
		pool.clear();
		await Promise.all([...sessions].map((session) => {
			if (session.connecting) {
				session.destroy();
				return;
			}
			return session.closed ? void 0 : new Promise((r) => session.close(() => r()));
		}));
	} });
}
/** Keep the session ref'd while anyone waits on it; an idle or unread one lets the process exit. */
function hold(p) {
	if (p.holds++ === 0) p.session.ref();
}
function release(p) {
	if (--p.holds === 0 && !p.session.destroyed) p.session.unref();
}
function untilAborted(p, signal) {
	if (signal === void 0) return p;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then((v) => {
			signal.removeEventListener("abort", onAbort);
			resolve(v);
		}, (e) => {
			signal.removeEventListener("abort", onAbort);
			reject(e);
		});
	});
}
const RETRYABLE_CODES = /* @__PURE__ */ new Set(["ERR_HTTP2_GOAWAY_SESSION", "ERR_HTTP2_INVALID_SESSION"]);
function send(pooled, headers, body, init, signal) {
	return new Promise((resolve) => {
		let stream;
		try {
			stream = pooled.session.request(headers, { endStream: body === void 0 });
		} catch (err) {
			const code = err.code;
			resolve({
				kind: code !== void 0 && RETRYABLE_CODES.has(code) ? "retry" : "error",
				error: err
			});
			return;
		}
		hold(pooled);
		let settled = false;
		const settle = (o) => {
			if (settled) return;
			settled = true;
			release(pooled);
			resolve(o);
		};
		const onAbort = () => {
			stream.close(http2.constants.NGHTTP2_CANCEL);
			settle({
				kind: "error",
				error: abortError(signal)
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		stream.once("close", () => {
			signal?.removeEventListener("abort", onAbort);
			const refused = stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM;
			settle({
				kind: refused ? "retry" : "error",
				error: /* @__PURE__ */ new Error(`stream closed before a response (code ${stream.rstCode})`)
			});
		});
		stream.once("error", (err) => settle({
			kind: "error",
			error: err
		}));
		stream.once("response", (h) => {
			const status = Number(h[":status"]);
			const responseHeaders = new Headers();
			for (const [name, value] of Object.entries(h)) {
				if (name.startsWith(":") || value === void 0) continue;
				for (const v of Array.isArray(value) ? value : [String(value)]) responseHeaders.append(name, v);
			}
			if (status >= 300 && status < 400 && responseHeaders.has("location") && init.redirect !== "manual") {
				stream.close(http2.constants.NGHTTP2_CANCEL);
				settle({
					kind: "error",
					error: /* @__PURE__ */ new TypeError(`redirect refused: ${status} to ${responseHeaders.get("location")}`)
				});
				return;
			}
			const nullBody = status === 204 || status === 205 || status === 304 || headers[":method"] === "HEAD";
			let response;
			try {
				response = new Response(nullBody ? null : webBody(stream, pooled, signal), {
					status,
					headers: responseHeaders
				});
			} catch (err) {
				stream.close(http2.constants.NGHTTP2_CANCEL);
				settle({
					kind: "error",
					error: err
				});
				return;
			}
			if (nullBody) stream.resume();
			settle({
				kind: "response",
				response
			});
		});
		if (body !== void 0) stream.end(body);
	});
}
/**
* The response body as a web stream with backpressure. The session stays ref'd
* only while the reader is waiting for data, so a body nobody reads lets the
* process exit. An unread body still holds its HTTP/2 stream open until the
* server finishes it: read or cancel every body. Cancelling resets the stream.
* Built by hand rather than with `Readable.toWeb`, which aborts h2 bodies early under Bun.
*/
function webBody(stream, pooled, signal) {
	let done = false;
	let holding = false;
	const setHold = (on) => {
		if (on === holding) return;
		holding = on;
		if (on) hold(pooled);
		else release(pooled);
	};
	const finish = () => {
		done = true;
		setHold(false);
	};
	return new ReadableStream({
		start(controller) {
			stream.on("data", (chunk) => {
				if (done) return;
				controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
				if ((controller.desiredSize ?? 1) <= 0) {
					stream.pause();
					setHold(false);
				}
			});
			stream.once("end", () => {
				if (done) return;
				finish();
				if (signal?.aborted) controller.error(abortError(signal));
				else controller.close();
			});
			stream.once("error", (err) => {
				if (done) return;
				finish();
				controller.error(signal?.aborted ? abortError(signal) : err);
			});
			stream.once("close", () => {
				if (done) return;
				finish();
				controller.error(signal?.aborted ? abortError(signal) : /* @__PURE__ */ new Error(`stream closed before its end (code ${stream.rstCode})`));
			});
		},
		pull() {
			if (done) return;
			setHold(true);
			stream.resume();
		},
		cancel() {
			finish();
			stream.close(http2.constants.NGHTTP2_CANCEL);
		}
	});
}
/**
* The Node and Bun client: the browser surface, plus env-driven signing,
* `diagnose`, and the `node:http2` fetch that `substrateFetch` uses from here on.
*/
setSubstrateFetch(createH2Fetch());

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/script-DgXaJY1Y.js
createRequire(import.meta.url);

//#endregion
//#region ../../node_modules/.pnpm/@mnmal-ai+substrate@1.0.0-alpha.19/node_modules/@mnmal-ai/substrate/dist/client.js
createRequire(import.meta.url);

//#endregion
//#region ../synoptic/src/agent-auth.js
const TTL_SECONDS = 3600;
const REFRESH_SKEW = 60;
/**
* What this identity CLAIMS when nothing overrides it.
*
* The claim is narrowed by the kid's _system/Key row — the server does
* `intersectList(claimed, row.capabilities)` — so the row is the authority and
* the token only asks. A token can never widen itself, which is why claiming a
* superset is safe.
*
* THE HAZARD RUNS THE OTHER WAY, and it is why these stopped being hardcoded.
* A claim that OMITS what the row grants intersects it AWAY. An identity
* registered `admin` against a fixed `['read','mutate']` claim mints a token
* carrying NOTHING: `/substrate/v1/whoami` answers, the identity is verified and
* correctly attributed, and every `/substrate/v1/query` returns
* `{"code":"forbidden","required":"read","have":[]}`.
*
* These remain the DEFAULTS because they are right for every cold-start
* identity in the fleet — the hooks only read, and `mutate` is there for the
* mailbox ack path. The override exists for the identity the defaults are
* wrong for.
*/
const DEFAULT_CAPABILITIES = ["read", "mutate"];
const DEFAULT_NAMESPACES = ["*"];
/**
* Parse a comma-separated env override into a claim list.
* Returns `null` for unset/blank, so an empty string cannot silently mint a
* zero-capability token — which is the exact failure this whole area is about.
*/
function claimList(raw) {
	if (typeof raw !== "string") return null;
	const items = raw.split(",").map((x) => x.trim()).filter((x) => x !== "");
	return items.length === 0 ? null : items;
}
function b64url(buf) {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function mint(kid, key, ns, capabilities, aud) {
	const now = Math.floor(Date.now() / 1e3);
	const exp = now + TTL_SECONDS;
	const signingInput = `${b64url(Buffer.from(JSON.stringify({
		alg: "EdDSA",
		typ: "JWT",
		kid
	}), "utf8"))}.${b64url(Buffer.from(JSON.stringify({
		sub: kid,
		aud,
		iat: now,
		exp,
		ns,
		capabilities
	}), "utf8"))}`;
	return {
		jwt: `${signingInput}.${b64url(sign(null, Buffer.from(signingInput, "utf8"), key))}`,
		exp
	};
}
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;
/**
* The origin a token for `url` names as its `aud`. Throws rather than mint a
* token without one, or one bound for plain http to a non-loopback host, where
* the network can read it. Same rule as substrate-client's `tokenAudience`.
*/
function audienceOf(url) {
	const raw = typeof url === "object" && url !== null && "url" in url ? url.url : url;
	let parsed;
	try {
		parsed = new URL(String(raw));
	} catch {
		throw new Error(`cannot mint an agent token without an audience: '${raw}' is not a URL`);
	}
	if (parsed.protocol === "https:" || parsed.protocol === "http:" && LOOPBACK.test(parsed.hostname)) return parsed.origin;
	throw new Error(`refusing to send an agent token to ${parsed.origin}: use https, or plain http only to a loopback host`);
}
function misconfigured(detail) {
	return {
		claim: null,
		getAuthHeader: () => null,
		warning: `<!-- agent identity misconfigured: ${detail} — reads are anonymous -->\n`
	};
}
/**
* Build the hook's auth state from env, with `opts.kid` / `opts.key` overrides
* (the OpenCode V2 skin delivers identity through plugin config — `ctx.options`
* — because a per-project identity cannot live in a shared process env; opts
* win over env).
* @returns {{ getAuthHeader: () => string|null, warning: string|null }}
*   - both unset (env and opts) → anonymous, no warning (the supported open mode)
*   - both set + key loads → getAuthHeader yields `Bearer <jwt>` (cached, refreshed near expiry)
*   - anything in between → anonymous + visible warning, never a throw
*
* The warning names the `options.*` spelling only when `opts` was passed at
* all. A Claude hook is a spawned process that receives env and
* nothing else, so naming a plugin option there points at a setting its
* operator cannot reach. The OpenCode skin always passes an identity object,
* even an empty one, because that seam exists for it.
*/
function createAgentAuth(env, opts) {
	const hasOptionsSeam = opts !== void 0;
	opts ??= {};
	const optionsIdentity = opts.kid !== void 0 && opts.kid !== null && opts.kid !== "" || opts.key !== void 0 && opts.key !== null && opts.key !== "";
	const keyPath = optionsIdentity ? opts.key : env.SUBSTRATE_AGENT_KEY_PATH;
	const kid = optionsIdentity ? opts.kid : env.SUBSTRATE_AGENT_KEY_ID;
	const hasKey = typeof keyPath === "string" && keyPath !== "";
	const hasKid = typeof kid === "string" && kid !== "";
	if (!hasKey && !hasKid) return {
		getAuthHeader: () => null,
		warning: null,
		claim: null
	};
	if (!hasKey || !hasKid) {
		const [envName, optionName] = hasKey ? ["SUBSTRATE_AGENT_KEY_ID", "options.kid"] : ["SUBSTRATE_AGENT_KEY_PATH", "options.key"];
		return misconfigured(`${hasOptionsSeam ? `${envName} / ${optionName}` : envName} is not set`);
	}
	let key;
	try {
		key = createPrivateKey(readFileSync(keyPath, "utf8"));
	} catch (err) {
		return misconfigured(`cannot load ${keyPath}: ${String(err?.message ?? err)}`);
	}
	if (key.asymmetricKeyType !== "ed25519") return misconfigured(`${keyPath} is a ${key.asymmetricKeyType ?? "non-asymmetric"} key; agent tokens are EdDSA and need an ed25519 key`);
	const capabilities = opts.capabilities ?? claimList(env.SUBSTRATE_AGENT_CAPABILITIES) ?? DEFAULT_CAPABILITIES;
	const ns = opts.namespaces ?? claimList(env.SYNOPTIC_AGENT_NAMESPACES) ?? DEFAULT_NAMESPACES;
	if (capabilities.includes("*")) return misconfigured(`capabilities cannot be claimed as '*' — the capability gates do a bare \`includes\` with no wildcard branch, so a wildcard claim is refused everything. Enumerate them instead, e.g. SUBSTRATE_AGENT_CAPABILITIES=${DEFAULT_CAPABILITIES.join(",")}`);
	const cached = /* @__PURE__ */ new Map();
	return {
		/** @param {string|URL|Request} [url] The request URL; its origin is the token's `aud`. */
		getAuthHeader: (url = env.SUBSTRATE_URL) => {
			const aud = audienceOf(url);
			const now = Math.floor(Date.now() / 1e3);
			let entry = cached.get(aud);
			if (entry === void 0 || entry.exp - REFRESH_SKEW <= now) {
				entry = mint(kid, key, ns, capabilities, aud);
				cached.set(aud, entry);
			}
			return `Bearer ${entry.jwt}`;
		},
		warning: null,
		/** What this identity CLAIMS — the request, never the grant. See `probeWhoami` for the grant. */
		claim: {
			ns,
			capabilities
		}
	};
}
/**
* Wrap a fetch implementation so every request carries the agent JWT when one
* is available. The single seam for the whole hook — every HTTP helper takes
* an injectable fetchImpl, so signing needs no per-call-site changes.
*/
function makeSignedFetch(getAuthHeader, fetchImpl = substrateFetch) {
	return (url, init = {}) => {
		const header = getAuthHeader(url);
		if (header === null) return fetchImpl(url, init);
		return fetchImpl(url, {
			...init,
			redirect: "error",
			headers: {
				...init.headers,
				authorization: header
			}
		});
	};
}

//#endregion
//#region ../synoptic/src/audit/check.js
/** @typedef {{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }} Check */
/** One check line. `unknown` requires a reason — a hole with no explanation is not reportable. */
function check(id, state, text, detail) {
	if (state === "unknown" && (detail === void 0 || detail === null || detail === "")) throw new Error(`audit check '${id}' is unknown without a reason`);
	return detail === void 0 ? {
		id,
		state,
		text
	} : {
		id,
		state,
		text,
		detail
	};
}

//#endregion
//#region ../synoptic/src/audit/identity.js
/**
* Identity reconciliation.
*
* `resolvedKid` must come from the RUNNING MCP server or from a write's
* `_metadata.createdBy` — never from the auditing process's own environment.
* The auditing shell can lack SUBSTRATE_AGENT_KEY_ID while the MCP child has
* it, because mise exports per-directory into the LAUNCHING shell. An
* audit reading its own env reports "no identity" on a correctly configured box.
*
* @param {{ resolvedKid: string|null, source: string|null, declaredName: string|null,
*           keyFilePresent: boolean|null, directoryKids: ReadonlyArray<string>|null }} p
*/
function auditIdentity({ resolvedKid, source, declaredName, keyFilePresent, directoryKids }) {
	const out = [];
	if (resolvedKid === null) {
		out.push(check("identity.resolved", "unknown", "could not determine the signing identity", "ask the running MCP server or read _metadata.createdBy from a write — never this process’s own env, which does not carry it"));
		return out;
	}
	out.push(check("identity.resolved", "ok", `${resolvedKid} (source: ${source ?? "unknown"})`));
	if (declaredName === null) out.push(check("identity.declared", "unknown", "repo declares no agent name, so the resolved kid cannot be checked", "a derivation with nothing to compare against cannot drift OR be verified"));
	else if (!resolvedKid.startsWith(`${declaredName}@`)) out.push(check("identity.declared", "warn", `repo declares '${declaredName}' but the environment resolved '${resolvedKid}'`, "most often a session launched from a SUBDIRECTORY, which mints an unregistered kid"));
	else out.push(check("identity.declared", "ok", `matches the declared '${declaredName}'`));
	if (keyFilePresent === null) out.push(check("identity.key", "unknown", "key directory not readable", "cannot list ~/.config/substrate/keys"));
	else if (!keyFilePresent) out.push(check("identity.key", "warn", "no key file for this kid", "reads degrade to anonymous — weaker, but not broken"));
	else out.push(check("identity.key", "ok", "key file present"));
	if (directoryKids === null) out.push(check("identity.registered", "unknown", "AgentIdentity directory unreadable", "the server was not reachable, so registration state is unverified"));
	else if (!directoryKids.includes(resolvedKid)) out.push(check("identity.registered", "warn", `'${resolvedKid}' has no AgentIdentity row`, keyFilePresent === true ? "a PRESENT key with an unregistered kid 401s every read and reports as \"substrate offline\". If this kid is deliberately rowless, assert it with an inactive AgentIdentity row carrying intent + expected-live (continuous|per-run) instead of writing a live row." : "half-registered identity. If deliberately rowless, assert it with an inactive AgentIdentity row carrying intent + expected-live instead of writing a live row."));
	else out.push(check("identity.registered", "ok", "registered in the directory"));
	return out;
}
/**
* Is the credential this process signs with the TARGET's credential?
*
* Exported because two sections depend on the answer and must not each derive
* it: `authority` reports the grant, and `recall.available` reports whether
* hybrid recall answers — a per-credential fact, so probing it with the
* auditor's key answers about the auditor.
*
* Both accepted witnesses are TARGET-derived: the kid of the MCP server running
* in the target directory, and the kid the target's own `.mcp.json` pins. The
* auditing process's env is deliberately not one of them.
*/
function credentialIsTargets({ whoami, resolvedKid = null, declaredKid = null }) {
	const subject = whoami?.ok === true && whoami.authenticated === true ? whoami.id ?? null : null;
	if (subject === null) return false;
	return subject === resolvedKid || subject === declaredKid;
}
/**
* What this credential is AUTHORISED to do.
*
* ## The gap this closes
*
* Every other identity check in this file models identity as *key files on disk
* vs `AgentIdentity` rows*. Neither is authority. The _system/Key table is, so a
* decommissioned agent whose key was never revoked still holds a live
* credential, and the file-based checks cannot tell it apart from a revoked one.
*
* Worse, `orphans.keys` keys off key FILES, so deleting a private key — the act
* that feels like decommissioning — makes the audit QUIETER while the credential
* stays live.
*
* ## What this can and cannot see, stated because the boundary matters
*
* whoami is a SELF view. It answers "what does the credential I am signing with
* hold", authoritatively and post-intersection. It cannot enumerate the key
* table, so it does NOT close:
*
*   - a registered _system/Key with no directory row
*   - a retired directory row with a live key, for identities OTHER than this one
*
* Those need admin enumeration and stay open. Claiming otherwise would be the
* same overreach this check exists to catch, so the render says so.
*
* @param {{ whoami: { ok: boolean, authEnabled?: boolean|null,
*                     authenticated?: boolean, id?: string|null,
*                     capabilities?: string[]|null, namespaces?: string[]|null,
*                     grants?: Record<string, string[]>|null,
*                     failed?: string },
*           expectedNamespaces: ReadonlyArray<string>,
*           expectedCapabilities?: Record<string, ReadonlyArray<string>>|null,
*           resolvedKid: string|null, declaredKid: string|null,
*           selfAudit: boolean, authWarning: string|null }} p
*/
function auditAuthority({ whoami, expectedNamespaces = [], expectedCapabilities = null, resolvedKid = null, declaredKid = null, selfAudit = true, authWarning = null }) {
	if (whoami === null || whoami === void 0 || whoami.ok !== true) {
		const reason = whoami?.failed ?? "no whoami probe was run";
		const revoked = /\b401\b/.test(reason);
		return [check("authority.grant", revoked ? "warn" : "unknown", revoked ? "this credential was REJECTED by the server (401)" : "could not ask the server what this credential holds", revoked ? `${reason} — a registered, unrevoked key does not 401. Either this kid was revoked, or the key on disk does not match the registered public key. Reads are degrading to anonymous or failing outright.` : `${reason} — so namespaces and capabilities are unverified. This is the one identity fact the local filesystem and the AgentIdentity directory cannot supply.`)];
	}
	if (whoami.authenticated !== true) {
		if (whoami.authEnabled === false) return [check("authority.grant", "warn", "this server VERIFIES NOTHING — auth is disabled", "every credential here is decorative: writes attribute to whoever claims them, and `_metadata.createdBy` records a claim rather than a signature. Presenting a key would change nothing. This is a deployment posture, so the fix is at the server, not in this repo.")];
		if (whoami.authEnabled === true) {
			const local = typeof authWarning === "string" ? authWarning.trim() : null;
			return [check("authority.grant", "warn", "auth is ENABLED and this request carried no credential — reads are landing anonymously", local === null ? "a present-but-invalid token 401s before this answer, so nothing was rejected: nothing was sent. SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH never took effect for this process. On a reads-open stack an anonymous read and an authenticated one are byte-identical, so this state can persist unnoticed — this is that state, named." : `the signer says why, so this is NOT the env-never-arrived case: ${local}. Both env vars reached this process; the credential itself could not be loaded, so the fix is the key material rather than the wiring. A present-but-invalid token 401s before this answer, so nothing was rejected — nothing was sent.`)];
		}
		return [check("authority.grant", "unknown", "the server resolved no identity for this request", "the server answered without `authEnabled`, a response shape this client does not understand, so it cannot say whether this instance verifies nothing or the probe carried no Authorization header. A present-but-invalid token 401s before that handler runs, so this is NOT evidence that a token was rejected.")];
	}
	const out = [];
	const flatNs = whoami.namespaces;
	const caps = whoami.capabilities;
	const grants = whoami.grants ?? null;
	const ns = flatNs ?? (grants === null ? null : Object.keys(grants).sort());
	if (grants === null && (flatNs === null || caps === null)) {
		out.push(check("authority.grant", "unknown", "whoami answered in a shape this client does not understand", "older servers default namespaces and capabilities to [] in the route, and current ones drop both and send `grants` instead — so on every supported version an absent field with NO `grants` beside it is version skew rather than an empty grant, and reading it as empty would understate authority rather than overstate it. Neither shape that carries `grants` lands here: older servers null `capabilities` on purpose, current ones remove both flat fields, and both put the real answer in `grants`. None arrived."));
		return out;
	}
	const subject = whoami.id ?? null;
	const attributed = credentialIsTargets({
		whoami,
		resolvedKid,
		declaredKid
	});
	if (selfAudit && resolvedKid !== null && subject !== null && subject !== resolvedKid) out.push(check("authority.grant", "warn", `signing as '${subject}' but this repo resolved '${resolvedKid}'`, "every write from this session attributes to the server-side identity, not the one the config names — never borrow another agent’s key"));
	if (!attributed) {
		const claimed = resolvedKid ?? declaredKid;
		out.push(check("authority.grant", "unknown", `read ${ns.includes("*") ? "'*' — EVERY namespace" : ns.join(",") || "no namespace"} (${describeGrant({
			caps,
			grants
		})}) for ${subject === null ? "a credential the server did not name" : `'${subject}'`} — NOT established as this target's`, claimed === null ? "nothing target-derived names whose credential this is: no MCP server is running in the target dir and its .mcp.json pins no SUBSTRATE_AGENT_KEY_ID, so the grant above is whatever credential the AUDIT PROCESS holds. An unresolved subject cannot have a verified authority — pin the kid per repo or run the audit from that repo’s own session." : `this target is '${claimed}', so the grant above belongs to a different identity — the one the AUDIT PROCESS holds. Ask \`substrate-admin list\` for the target’s real grant; nothing readable from here can supply it.`));
		out.push(...tail(whoami));
		return out;
	}
	if (grants !== null) {
		const readless = expectedNamespaces.filter((n) => {
			const held = capabilitiesOn(n, {
				caps,
				grants
			});
			return held.length > 0 && !held.includes("read");
		});
		if (readless.length > 0) {
			out.push(check("authority.grant", "warn", `verified as '${subject}' but holds no \`read\` on ${readless.join(", ")} — every read there is refused (${describeGrant({
				caps,
				grants
			})})`, `this is the state a flat capability list CANNOT express, which is why the server nulls \`capabilities\` rather than rendering the union — the union would say \`read\` because it is held somewhere. Frames against ${readless.join(", ")} return \`{"code":"forbidden","required":"read"}\` while every other namespace answers normally, so the failure is partial and the render looks healthy. Widen the grant with \`substrate-admin\`: an entry is \`<ns>:<cap>+<cap>\`, and an EXPLICIT entry beats a \`*\` entry rather than adding to it, so a narrow entry is not widened by a broad wildcard beside it.`));
			out.push(...tail(whoami));
			return out;
		}
	} else if (!caps.includes("read")) {
		out.push(check("authority.grant", "warn", `verified as '${subject}' but holds ${caps.length === 0 ? "NO capabilities" : `no \`read\` (caps: ${caps.join(",")})`} — every read is refused`, `whoami answers without gating on \`read\`, so this state renders as a healthy identity while \`/substrate/v1/query\` returns \`{"code":"forbidden","required":"read","have":[${caps.map((c) => `"${c}"`).join(",")}]}\`. The namespace grant below is moot until this is fixed. Two causes, and \`substrate-admin list\` tells them apart: the ROW may not grant \`read\`, or the row grants it and our TOKEN CLAIM omitted it — substrate intersects claim against row, so a claim that is a SUBSET of the row silently discards the difference. Widening a row is an operator action; widening the claim is ours. Note \`['*']\` is NOT a valid claim for capabilities — both gates do a bare \`includes\` with no wildcard branch, so a wildcard claim is refused everything.`));
		out.push(...tail(whoami));
		return out;
	}
	if (expectedCapabilities !== null) {
		const lacking = /* @__PURE__ */ new Map();
		for (const [n, needed] of Object.entries(expectedCapabilities)) {
			const held = grants !== null ? capabilitiesOn(n, {
				caps,
				grants
			}) : caps;
			if (held.length === 0) continue;
			for (const cap of needed) {
				if (cap === "read" || held.includes(cap)) continue;
				lacking.set(cap, [...lacking.get(cap) ?? [], n]);
			}
		}
		if (lacking.size > 0) {
			const what = [...lacking].map(([cap, names]) => `no \`${cap}\` on ${names.join(", ")}`);
			out.push(check("authority.grant", "warn", `verified as '${subject}' but holds ${what.join("; ")} — the capability declares it needs them (${describeGrant({
				caps,
				grants
			})})`, "reads succeed, so the session looks healthy, and the first write there is refused with `{\"code\":\"forbidden\"}`: SessionLogs, AnchorIntents and Memory in `cortext`, salience boosts in `recall`. Widen the grant with `substrate-admin`; an entry is `<ns>:<cap>+<cap>`."));
			out.push(...tail(whoami));
			return out;
		}
	}
	if (ns.includes("*")) {
		out.push(check("authority.grant", "warn", `granted '*' — EVERY namespace (${describeGrant({
			caps,
			grants
		})}) — as '${subject}'`, `this identity needs ${expectedNamespaces.length > 0 ? expectedNamespaces.join(",") : "a declared set"}. A wildcard is what \`substrate-admin register\` grants when \`--ns\` is OMITTED, so it is usually inherited rather than chosen.`));
		out.push(...tail(whoami));
		return out;
	}
	const missing = expectedNamespaces.filter((n) => !ns.includes(n));
	if (missing.length > 0) out.push(check("authority.grant", "warn", `missing namespace(s): ${missing.join(", ")} — granted ${ns.join(",")}`, "frames against a missing namespace are rejected per-key with `unauthorized_namespace`; the cold-start degrades rather than failing, so the render looks complete and simply carries a different heading"));
	else out.push(check("authority.grant", "ok", `granted ${ns.join(",")} (${describeGrant({
		caps,
		grants
	})}) — covers what this capability needs, as '${subject}'`));
	out.push(...tail(whoami));
	return out;
}
/**
* What this credential holds ON `name`.
*
* The resolution rule is substrate's `capabilitiesFor`, and it is NOT a union: an
* EXPLICIT entry BEATS the wildcard rather than adding to it. So
* `{'*': ['read'], cortext: ['read','mutate']}` confers exactly `read` on
* `recall` — reading it as `read,mutate` everywhere would over-report the one
* namespace the operator went out of their way to narrow, which is the whole
* reason they wrote two entries.
*
* A flat identity (no `grants` — a file-registry key, or any pre-5.23.0 server)
* has no per-namespace structure to consult, so every namespace confers the
* flat list. That is not an approximation: for a flat grant the two forms are
* the same grant, which is the equivalence substrate pins over a table in
* `test/_system/grant.test.ts`.
*/
function capabilitiesOn(name, { caps, grants }) {
	if (grants === null) return caps ?? [];
	if (Object.hasOwn(grants, name)) return grants[name];
	return Object.hasOwn(grants, "*") ? grants["*"] : [];
}
/**
* The grant, spelled for a human.
*
* Keyed on `caps` rather than on `grants`, and that is the whole point: a
* NON-NULL `caps` is substrate's own assertion that a flat list is honest here, so
* a uniform per-namespace grant keeps rendering `caps: read,mutate` exactly as a
* flat grant does. The
* two-dimensional spelling appears only where one-dimensional would lie.
*
* When it does appear it uses substrate's own `encodeGrant` entry syntax
* (`cortext:read+mutate`), so the line an operator reads here matches the line
* `substrate-admin list` shows them. A second spelling for the same fact would make
* the two impossible to diff by eye, which is the only way anyone checks them.
*/
function describeGrant({ caps, grants }) {
	if (caps !== null && caps !== void 0) return `caps: ${caps.join(",") || "none"}`;
	const entries = Object.entries(grants ?? {}).map(([n, c]) => `${n}:${[...c].sort().join("+")}`);
	return entries.length === 0 ? "grant: NOTHING" : `grant: ${entries.sort().join(" ")}`;
}
function tail() {
	return [fleetCaveat()];
}
/** Never let the self-view read as a fleet audit. This is the caveat for the
*  fleet-wide checks a self view cannot make. `info`, not `unknown`: it is
*  true of every run, so as an unknown it would make the audit exit 1 forever
*  and "Nothing to do" unreachable. */
function fleetCaveat() {
	return check("authority.fleet", "info", "other identities’ credentials are not visible from here", "whoami is a self view. A registered _system/Key with no directory row, or a retired row whose key is still live, needs `substrate-admin list` and stays unchecked — a decommissioned agent can hold a live `*` credential with nothing here showing it");
}

//#endregion
//#region ../synoptic/src/inbox-push.js
/** D5 switches. PUSH defaults on, WAKE defaults OFF (D1 — on only after the live check). */
function readInboxKnobs(env) {
	return {
		push: env.SYNOPTIC_INBOX_PUSH !== "off",
		wake: env.SYNOPTIC_INBOX_WAKE === "on",
		urgentFrom: (env.SYNOPTIC_INBOX_URGENT_FROM ?? "").split(",").map((s) => s.trim()).filter(Boolean)
	};
}

//#endregion
//#region ../synoptic/src/audit/inbox.js
/**
* The inbox push switches (synoptic 2.4.0), as this repo resolves
* them: process env first, then `.claude/settings.local.json`, the same overlay
* the watcher reads when it starts.
*
* A value that is neither of the two the code recognises is the failure worth
* catching. `readInboxKnobs` treats anything but "off" as push ON and anything
* but "on" as wake OFF, so `SYNOPTIC_INBOX_PUSH=false` silently does nothing. The
* audit says so instead.
*
* The urgent allowlist is printed: kids are public directory names, not secrets.
*/
function auditInboxPush({ env }) {
	const knobs = readInboxKnobs(env);
	const out = [];
	const pushRaw = env.SYNOPTIC_INBOX_PUSH;
	if (pushRaw !== void 0 && pushRaw !== "" && pushRaw !== "off" && pushRaw !== "on") out.push(check("inbox.push", "warn", `SYNOPTIC_INBOX_PUSH="${pushRaw}" is not "off", so push stays on`, "only the literal \"off\" disables it"));
	else if (!knobs.push) out.push(check("inbox.push", "ok", "push off (SYNOPTIC_INBOX_PUSH=off)", "mail arrives as summary lines at the prompt and at Stop, as before 2.4.0"));
	else if (!env.SUBSTRATE_AGENT_KEY_ID) out.push(check("inbox.push", "warn", "push on, but no agent identity is wired", "the watcher needs SUBSTRATE_AGENT_KEY_ID to find this repo's inbox, so nothing is pushed"));
	else out.push(check("inbox.push", "ok", "push on: agent mail is delivered mid-turn", "SYNOPTIC_INBOX_PUSH=off is the rollback; it takes effect at the next session start"));
	const wakeRaw = env.SYNOPTIC_INBOX_WAKE;
	if (wakeRaw !== void 0 && wakeRaw !== "" && wakeRaw !== "on" && wakeRaw !== "off") out.push(check("inbox.wake", "warn", `SYNOPTIC_INBOX_WAKE="${wakeRaw}" is not "on", so wake stays off`, "only the literal \"on\" enables it"));
	else out.push(check("inbox.wake", "ok", knobs.wake ? "wake on: idle mail starts a turn (6/hour, 2/thread)" : "wake off: idle mail waits for the next prompt"));
	out.push(knobs.urgentFrom.length === 0 ? check("inbox.urgent", "ok", "urgent preemption off (no SYNOPTIC_INBOX_URGENT_FROM)") : check("inbox.urgent", "ok", `urgent preemption allowed from ${knobs.urgentFrom.length} kid(s): ${knobs.urgentFrom.join(", ")}`, "their priority:urgent mail may stop a running turn (3/hour)"));
	return out;
}

//#endregion
//#region ../synoptic/src/audit/install.js
/**
* How many cached plugin versions is too many.
*
* Not hygiene: every cached directory is a live skill source, and multiple
* plausible answers to "the plugin's copy" sitting side by side is how a
* session ends up on a stale copy. The resolver now chooses
* explicitly, so pruning is belt-and-braces rather than load-bearing — but a
* resolver bug is survivable only if the set of wrong answers is small.
*
* Two: the installed version, plus one to roll back to.
*/
const CACHE_KEEP = 2;
/**
* Plugin-cache reconciliation.
*
* ## Why each fact carries WHY it is missing
*
* As nullable primitives, three inputs here would answer two questions at once
* with one null: "I could not look" and "I looked, and the answer is bad."
* Those are different states in this file's own model — `unknown` versus `warn`
* (see the note at the top) — and collapsing them reports a verified defect as
* a hole:
*
*   installedVersion  null   registry unreadable | no cortext entry | no version field
*   cacheVersions     []     cache dir unreadable | dir read fine and EMPTY
*   servedVersion     null   CLAUDE_PLUGIN_ROOT unset | set, but no readable marker
*
* The left cause of each pair is a genuine hole. The right one is a verified
* bad answer — an unregistered plugin, an empty cache, a served root with no
* fragment — and each was rendering as `????` with a `detail` that ASSERTED the
* left cause. "cache not readable" is simply false about a cache that read
* fine and was empty.
*
* The caller now says which. `audit-entry.js` built the collapse with
* `listOrNull(cacheDir) ?? []` and a bare `catch { }` — the same
* `data[key] ?? []` move the conventions fragment warns about, where the thing
* destroyed is PRESENCE, not emptiness.
*
* All three discriminators default to the unknown-producing value and treat an
* unrecognised value the same way. A caller that stops passing one degrades to
* reporting a hole, never to claiming health.
*
* @param {{ installedVersion: string|null,
*           installedRegistry?: 'unreadable'|'no-entry'|'malformed'|'present',
*           cacheVersions: ReadonlyArray<string>,
*           cacheDir?: 'unreadable'|'readable',
*           servedVersion: string|null,
*           servedRoot?: 'unset'|'set',
*           compare: (a: string, b: string) => number }} p
*/
function auditPlugin({ installedVersion, installedRegistry = "unreadable", cacheVersions, cacheDir = "unreadable", servedVersion, servedRoot = "unset", compare }) {
	const out = [];
	const sorted = [...cacheVersions].sort(compare);
	if (installedVersion !== null) out.push(check("plugin.installed", "ok", `installed ${installedVersion}`));
	else if (installedRegistry === "no-entry") out.push(check("plugin.installed", "warn", "no cortext@mnmal-ai entry in installed_plugins.json", "the registry read fine and does not list this plugin — a hand-dropped copy never meets a package manager, so nothing establishes a downgrade floor and the pin below has nothing to reconcile against"));
	else if (installedRegistry === "malformed") out.push(check("plugin.installed", "warn", "the cortext@mnmal-ai registry entry carries no version", "the entry exists but its `version` is absent — a malformed registry, not a missing install"));
	else out.push(check("plugin.installed", "unknown", "installed version unresolved", "installed_plugins.json could not be read or parsed, so whether this plugin is registered is unknown — distinct from reading it and finding no entry"));
	if (cacheVersions.length > 0 && cacheVersions.length <= 2) out.push(check("plugin.cache", "ok", `cache holds ${cacheVersions.length} version(s)`));
	else if (cacheVersions.length === 0 && cacheDir === "readable") out.push(check("plugin.cache", "warn", "the plugin cache is EMPTY", "the cache directory read fine and holds no version with a readable fragment — every skill source is missing, which is a broken install rather than an unchecked one"));
	else if (cacheVersions.length === 0) out.push(check("plugin.cache", "unknown", "cache not readable", "the plugin cache directory could not be listed, so what it holds is unknown — distinct from listing it and finding it empty"));
	else if (cacheVersions.length > 2) out.push(check("plugin.cache", "warn", `cache holds ${cacheVersions.length} versions (${sorted[0]} … ${sorted[sorted.length - 1]})`, `every one is a live skill source; keep ${2} (installed + one rollback) so a resolver bug has fewer wrong answers available. Fix: node "$CLAUDE_PLUGIN_ROOT/bin/prune-cache.mjs" (dry-run; add --apply to delete)`));
	const rootState = SERVED_ROOT_STATES.has(servedRoot) ? servedRoot : "unrecognised";
	if (servedVersion === null && (rootState === "set" || rootState === "derived-cache")) out.push(check("plugin.served", "warn", rootState === "set" ? "CLAUDE_PLUGIN_ROOT is set but carries no readable fragment marker" : "the plugin directory this audit is running from carries no readable fragment marker", "the serving root was named and looked at, and it has no version to report — a broken or half-written plugin directory, not an unasked question"));
	else if (rootState === "derived-source") out.push(check("plugin.served", "unknown", "this audit is running from a SOURCE TREE, not a plugin install", "so it can report what it is running, but not what served the skill this session is following — those are different trees whenever the source is ahead of the install, which in this repo is most of the time"));
	else if (servedVersion === null) out.push(check("plugin.served", "unknown", "cannot tell which version served this skill", "no serving root could be named or derived, so there is nothing to interrogate — distinct from a root that was found and unreadable"));
	else if (installedVersion !== null && compare(servedVersion, installedVersion) < 0) out.push(check("plugin.served", "warn", `this session was served ${servedVersion}, older than the installed ${installedVersion} — the skill text being followed is RETIRED`, `any instruction in it may have been superseded, and nothing reconciles skill prose the way the resolver reconciles the fragment. Re-read the skill from the installed version before acting on it, and restart the session to rebind CLAUDE_PLUGIN_ROOT.`));
	else out.push(check("plugin.served", "ok", `served ${servedVersion}`));
	return out;
}
/** The serving roots `auditPlugin` recognises. `set` = CLAUDE_PLUGIN_ROOT was
*  present; `derived-cache` = located from this file's own path inside the
*  plugin cache; `derived-source` = located, but in a source checkout.
*  Anything else is a caller error and reports a hole. */
const SERVED_ROOT_STATES = /* @__PURE__ */ new Set([
	"set",
	"derived-cache",
	"derived-source",
	"unset"
]);
/**
* Fragment state, expressed from a resolver result so the audit and the
* installer can never disagree about what "current" means.
*/
function auditFragment(resolution) {
	switch (resolution.action) {
		case "current": return [check("fragment", "ok", `repo is current (${resolution.chosen.digest})`)];
		case "install": return [check("fragment", "warn", "repo fragment differs from the best available", `would install ${resolution.chosen.version}+${resolution.chosen.digest} — run /substrate-setup`)];
		case "skip-source-repo": return [check("fragment", "ok", "this repo SHIPS the fragment; its tree is authoritative")];
		default: return [check("fragment", "unknown", "could not resolve a fragment to compare", resolution.reason)];
	}
}

//#endregion
//#region ../synoptic/src/audit/mcp-json.js
/**
* Is a TRACKED `.mcp.json` still the committable form?
*
* The gitignore rule is conditional on CONTENT rather than on the file's name: a fully-indirected file (pure `${VAR}` refs, public
* `SUBSTRATE_URL` literal) is committed, and one carrying an absolute path, a
* host-pinned kid or a literal secret is ignored.
*
* The rule introduces exactly one failure mode: a file that starts portable and
* STAYS TRACKED while someone edits a machine value into it. The cost lands in
* git history, where it is not retractable.
*
* ## What is deliberately NOT flagged
*
* `${VAR:-default}` is not automatically machine-specific. The skill's own Step
* 4.2 form uses `${SUBSTRATE_AGENT_KEY_ID:-default}`, whose fallback is the FLEET
* default rather than a host-pinned identity. So a kid fallback is flagged only
* when it names a host (`@`), and a path fallback only when it is absolute.
* Flagging every fallback would flag the arrangement this skill recommends.
*
* ## Values are never printed
*
* A `.mcp.json` env block can hold a token. Findings name the FIELD and the
* marker kind, never the value — the same discipline as the identity checks,
* which report a boolean for the key file rather than reading it out.
*
* @param {{ present: boolean|null, tracked: boolean|null,
*           markers: ReadonlyArray<{ field: string, kind: string }>|null }} p
*/
function auditMcpJson({ present, tracked, markers }) {
	if (present === null) return [check("mcp-json", "unknown", "a project .mcp.json exists but could not be read or parsed", "so whether it carries machine-specific values is unknown — distinct from reading it and finding none")];
	if (present === false) return [check("mcp-json", "ok", "no project .mcp.json", "nothing to commit or ignore — this repo uses a user-scope server or none")];
	if (tracked === null || markers === null) return [check("mcp-json", "unknown", "cannot tell whether .mcp.json is tracked", "git could not answer (not a repository, or the command failed), and an untracked-vs-committed distinction is the whole of this check")];
	const named = markers.map((m) => `${m.field} (${m.kind})`).join(", ");
	if (tracked && markers.length > 0) return [check("mcp-json", "warn", `.mcp.json is TRACKED and carries ${markers.length} machine-specific value(s): ${named}`, "the portable form is committed and this one is ignored. Every commit from here puts a machine path or an identity into git history, which is not retractable — either indirect the value through the environment (Step 7.2) or `git rm --cached .mcp.json` and ignore it")];
	if (tracked) return [check("mcp-json", "ok", ".mcp.json is tracked and fully indirected — the committable form")];
	if (markers.length > 0) return [check("mcp-json", "ok", `.mcp.json is ignored and carries machine-specific value(s): ${named} — correctly ignored`)];
	return [check("mcp-json", "ok", ".mcp.json is ignored and carries no machine-specific value", "harmless, but a tracked repo would commit this form: a fresh clone then gets a working server with no setup step")];
}

//#endregion
//#region ../synoptic/src/audit/orphans.js
/**
* Kid/key bindings declared in mise.toml env assignments.
*
* A daemon is never an MCP session, so its kid never appears in any
* `.mcp.json` — `APP_DAEMON_KID`/`APP_DAEMON_KEY` in `mise.toml` is the same
* kind of binding `scanKeyRefs` reads from MCP server env, and the audit must
* consult it before calling a key unowned.
*
* Pure: entries are already read. Groups assignments by their shared stem
* (`FOO_KID` + `FOO_KEY`/`FOO_SIGNING_KEY`), so a binding is only reported
* when the file actually writes it down — an unpaired name is not a binding.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string, source: string }>}
*/
function scanMiseRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		const env = {};
		for (const line of text.split("\n")) {
			const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*["']([^"']*)["']\s*(?:#.*)?$/.exec(line);
			if (m !== null) env[m[1]] = m[2];
		}
		const groups = /* @__PURE__ */ new Map();
		for (const [name, value] of Object.entries(env)) {
			const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
			if (m === null) continue;
			const g = groups.get(m[1]) ?? {};
			g[m[2] === "KID" || m[2] === "KEY_ID" ? "kid" : "key"] = value;
			groups.set(m[1], g);
		}
		for (const g of groups.values()) {
			if (typeof g.kid !== "string" || !g.kid.includes("@")) continue;
			if (typeof g.key !== "string" || g.key === "" || g.key.includes("$")) continue;
			const keyName = (g.key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName !== "") out.push({
				keyName,
				kid: g.kid,
				source: path
			});
		}
	}
	return out;
}
/**
* Kid/key bindings in a repo's `.codex/cortext.local.json` — the
* fourth surface. The Codex skin reads its identity from that file's `env`
* (or from the process env, which no file scan can see), never from
* `.mcp.json`, so without this scan `codex@host-a` would read as unreferenced
* while it signs every Codex session in the repo.
*
* Pure: entries are already read. Only an absolute path into `.config/substrate/keys/`
* counts, matching what the skin itself accepts.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string|null, source: string }>}
*/
function scanCodexRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		let env;
		try {
			env = JSON.parse(text)?.env;
		} catch {
			continue;
		}
		const key = env?.SUBSTRATE_AGENT_KEY_PATH;
		if (typeof key !== "string" || !key.startsWith("/") || !/\.config\/substrate\/keys\//.test(key)) continue;
		const keyName = (key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
		if (keyName === "") continue;
		const kid = env.SUBSTRATE_AGENT_KEY_ID;
		out.push({
			keyName,
			kid: typeof kid === "string" && kid.includes("@") ? kid : null,
			source: path
		});
	}
	return out;
}
/**
* Key bindings written into systemd units — the third surface, after
* `.mcp.json` and `mise.toml`. A daemon's worker can sign with
* `Environment=APP_SUBSTRATE_AGENT_KEY=%h/.config/substrate/keys/app.key`, and
* without this scan the audit would say "nothing signs with these" about it.
*
* Unlike the other two surfaces, a unit often names the key WITHOUT the kid —
* the daemon derives it elsewhere. So a key path alone is reported, with
* `kid: null`: it proves something signs with the key, which is the claim the
* orphan check was getting wrong, while claiming nothing about which kid.
*
* Only values pointing into `.config/substrate/keys/` count; `API_KEY=abc` and
* `SSH_KEY=%h/.ssh/...` are not Substrate bindings.
*
* Pure: entries are already read.
*
* @param {ReadonlyArray<{ path: string, text: string|null }>} entries
* @returns {Array<{ keyName: string, kid: string|null, source: string }>}
*/
function scanSystemdRefs(entries) {
	const out = [];
	for (const { path, text } of entries ?? []) {
		if (typeof text !== "string") continue;
		const env = {};
		for (const line of text.split("\n")) {
			const m = /^\s*Environment\s*=\s*(.*)$/.exec(line);
			if (m === null) continue;
			for (const t of m[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
				const tok = t[1] ?? t[2] ?? t[3] ?? "";
				const eq = tok.indexOf("=");
				if (eq > 0) env[tok.slice(0, eq)] = tok.slice(eq + 1);
			}
		}
		const groups = /* @__PURE__ */ new Map();
		for (const [name, value] of Object.entries(env)) {
			const m = /^(.*?)_(KID|KEY_ID|SIGNING_KEY|KEY_PATH|KEY|PUB)$/.exec(name);
			if (m === null) continue;
			const g = groups.get(m[1]) ?? {};
			if (m[2] === "KID" || m[2] === "KEY_ID") g.kid = value;
			else g.key = value;
			groups.set(m[1], g);
		}
		for (const g of groups.values()) {
			if (typeof g.key !== "string" || !/\.config\/substrate\/keys\//.test(g.key)) continue;
			const keyName = (g.key.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName === "") continue;
			const kid = typeof g.kid === "string" && g.kid.includes("@") ? g.kid : null;
			out.push({
				keyName,
				kid,
				source: path
			});
		}
	}
	return out;
}
/**
* Drift between the key files on disk and the directory rows.
*
* @param {{ keyNames: ReadonlyArray<string>|null, revokedNames: ReadonlyArray<string>|null,
*           directoryKids: ReadonlyArray<string>|null,
*           activeKids: ReadonlyArray<string>|null,
*           directoryRows: ReadonlyArray<{ kid: string, active: boolean, description: string|null, roaming?: boolean|null }>|null,
*           keyRefs: ReadonlyArray<{ keyName: string, kid: string|null, source: string }>|null,
*           refScanComplete: boolean }} p
*/
function auditOrphans({ keyNames, revokedNames, directoryKids, activeKids = null, directoryRows = null, keyRefs = null, refScanComplete = false }) {
	const out = [];
	if (keyNames === null || directoryKids === null) {
		out.push(check("orphans", "unknown", "cannot cross-check keys against the directory", keyNames === null ? "key directory unreadable" : "directory unreadable"));
		return out;
	}
	const liveKids = activeKids ?? directoryKids;
	const nameMatched = (n) => liveKids.some((k) => k.startsWith(`${n}@`));
	const unmatched = keyNames.filter((n) => !nameMatched(n));
	if (unmatched.length === 0) out.push(check("orphans.keys", "ok", "every key file has a directory row"));
	else if (keyRefs === null || keyRefs === void 0) out.push(check("orphans.keys", "unknown", `${unmatched.length} keypair(s) not matched by name: ${unmatched.join(", ")}`, "no .mcp.json scan available — a key file name is not its identity, so these cannot be called orphans. Re-run with --fleet to establish it."));
	else {
		const asserted = /* @__PURE__ */ new Map();
		if (directoryRows !== null && directoryRows !== void 0) {
			for (const r of directoryRows) if (r?.active === false && typeof r?.kid === "string" && typeof r?.description === "string" && r.description.trim() !== "") asserted.set(r.kid, r.description);
		}
		const isLive = (kid) => activeKids === null || activeKids === void 0 ? directoryKids.includes(kid) : activeKids.includes(kid);
		const refFor = (n) => keyRefs.find((r) => r.keyName === n && r.kid !== null) ?? keyRefs.find((r) => r.keyName === n) ?? null;
		const registered = [];
		const assertedList = [];
		const risky = [];
		const unreferenced = [];
		const kidless = [];
		for (const n of unmatched) {
			const ref = refFor(n);
			if (ref === null) unreferenced.push(n);
			else if (ref.kid === null) kidless.push(`${n} (used by ${ref.source}, kid not stated)`);
			else if (isLive(ref.kid)) registered.push(`${n} -> ${ref.kid}`);
			else if (asserted.has(ref.kid)) assertedList.push(`${n} -> ${ref.kid} (asserted absent by design)`);
			else risky.push(`${n} -> ${ref.kid}`);
		}
		if (risky.length > 0) out.push(check("orphans.keys", "warn", `${risky.length} keypair(s) configured against an unregistered kid: ${risky.join(", ")}`, "a PRESENT key with an unregistered kid 401s every read and reports as \"substrate offline\". If the kid is deliberately rowless (never Claim.author, never receives mail), assert it with an inactive AgentIdentity row carrying intent + expected-live (continuous|per-run) instead of writing a live row."));
		else if (unreferenced.length > 0) out.push(refScanComplete ? check("orphans.keys", "warn", `${unreferenced.length} keypair(s) unreferenced by any scanned config (.mcp.json, mise.toml, .codex/cortext.local.json, systemd user units): ` + unreferenced.join(", "), "no scanned config signs with these, so none of those can 401 on them — but a key used through a tool (e.g. an operator key a CLI enrolment writes) or by a process started some other way is invisible to a config scan. Confirm via `substrate-admin list` that no live credential depends on one before retiring it; a file scan cannot see revocation state, so retiring on this finding alone is unsound.") : check("orphans.keys", "unknown", `${unreferenced.length} keypair(s) not matched by name and not referenced here: ` + unreferenced.join(", "), "only this repo's configs were read — the repo that signs with one of these may not have been scanned. Re-run with --fleet before treating it as unowned."));
		else {
			const bits = [`every key file is accounted for (${[...registered, ...kidless].join(", ")})`];
			if (assertedList.length > 0) bits.push(`asserted absent by design: ${assertedList.join(", ")}`);
			out.push(check("orphans.keys", "ok", bits.join("; "), assertedList.length > 0 ? "asserted kids hold inactive, intent-documented directory rows (expected liveness per row description) — visible here rather than silently exonerated" : void 0));
		}
	}
	if (revokedNames !== null && revokedNames.length > 0) out.push(check("orphans.revoked", "warn", `${revokedNames.length} revoked keypair(s) still on disk: ${revokedNames.join(", ")}`, "harmless but indistinguishable from a live key at a glance"));
	const roamingKids = new Set((directoryRows ?? []).filter((r) => r?.roaming === true).map((r) => r.kid));
	const liveGroups = sameNameDifferentHost(activeKids ?? directoryKids);
	const isRoamingGroup = (g) => g.every((k) => roamingKids.has(k));
	const dupes = liveGroups.filter((g) => !isRoamingGroup(g));
	const roamingPairs = liveGroups.filter(isRoamingGroup);
	const roamingNote = roamingPairs.length > 0 ? ` (roaming, one per host by design: ${roamingPairs.map((g) => g.join(" / ")).join(" | ")})` : "";
	out.push(dupes.length === 0 ? check("orphans.hosts", "ok", `no LIVE agent name registered against two hosts${roamingNote}`) : check("orphans.hosts", "warn", `${dupes.length} name(s) on multiple hosts: ${dupes.map((c) => c.join(" / ")).join(" | ")}`, "expected if the agent genuinely runs on both; otherwise the host is being derived inconsistently (hostname -s on one path, a hardcoded value on another)"));
	if (activeKids !== null) {
		const retiredPairs = sameNameDifferentHost(directoryKids).filter((group) => !liveGroups.some((d) => d.join() === group.join()));
		if (retiredPairs.length > 0) out.push(check("orphans.retired", "ok", `${retiredPairs.length} name(s) with a retired host counterpart: ${retiredPairs.map((g) => g.join(" / ")).join(" | ")}`, "one live identity plus one deactivated — the normal end state of a host migration, and nothing to do"));
	}
	return out;
}
/**
* One agent NAME registered against more than one host.
*
* ## Why this is not a host-casing check
*
* Two registrations of one agent can differ by more than case:
*
*     peer-claude@laptop-b   active=true
*     peer-claude@laptop     active=false
*
* A case-insensitive check finds nothing there. A typical cause is
* `hostname -s` on one path against a hardcoded host in a template on another.
*
* So the invariant checked is the broader and actually-true one: one name, more
* than one host. Case-only variants are a subset and still caught.
*
* This can legitimately fire for an agent genuinely running on two machines, so
* it reports rather than accuses — the operator knows whether two hosts are two
* machines and the audit does not.
*
* @param {ReadonlyArray<string>} kids
* @returns {Array<Array<string>>} groups of kids sharing a name half.
*/
function sameNameDifferentHost(kids) {
	const byName = /* @__PURE__ */ new Map();
	for (const k of kids) {
		const at = k.lastIndexOf("@");
		if (at <= 0) continue;
		const name = k.slice(0, at);
		const set = byName.get(name) ?? /* @__PURE__ */ new Set();
		set.add(k);
		byName.set(name, set);
	}
	return [...byName.values()].filter((s) => s.size > 1).map((s) => [...s].sort());
}

//#endregion
//#region ../synoptic/src/audit/recall.js
/**
* Is semantic recall reachable at all, for this credential?
*
* One line, stating which branch was taken rather than reporting faults: a
* credential whose grant omits `recall` gets per-key `unauthorized_namespace`
* rejections that nothing else surfaces.
*
* ## Why this needs `reachable` and cannot infer it
*
* `recall` returns null for a refusal AND for an unreachable server — the
* two are deliberately merged there. An audit's response to them is NOT the same. "Recall
* does not answer" is a verified fault; "the server is down" is a check that
* could not run, and this module's one rule is that those must never render
* alike. Reported as a warn on an unreachable box, this line would assert a
* defect it never observed — the false-confidence bug inverted, which is no
* better for being loud instead of quiet.
*
* With the server up this branch is unreachable, so test it against a dead
* port.
*
* @param {{ answered: boolean, reachable: boolean, reason: string|null }} p
*/
function auditSemanticRecall({ answered, reachable, reason, credentialAttributed = true }) {
	if (!credentialAttributed) return [check("recall.available", "unknown", "recall was probed with a credential that is not established as this target’s", "whether recall answers depends on the asking credential’s namespace grant, so this probe answers for the auditor. See the authority section — the same substitution, one section up.")];
	if (answered) return [check("recall.available", "ok", "semantic recall answers")];
	if (!reachable) return [check("recall.available", "unknown", "could not reach the server, so whether recall answers is unknown", `${reason ?? "no reason given"} — an unreachable server is a check that did not run, not a recall fault`)];
	return [check("recall.available", "warn", "semantic recall does NOT answer for this credential", `${reason ?? "no reason given"} — the recall tool and recall/Hit frames fail for this credential; check its grant includes \`recall\``)];
}

//#endregion
//#region ../synoptic/src/audit/render.js
const MARKER = {
	ok: "ok  ",
	warn: "WARN",
	unknown: "????",
	info: "note"
};
/**
* Render the report.
*
* The summary counts `unknown` separately and never folds it into either side —
* see the note at the top of this file. A report that said "3 ok, 0 warnings"
* while four checks never ran is the bug this audit exists to find.
*/
function renderAudit(groups) {
	const lines = ["# /substrate-setup --audit — read-only reconciliation", ""];
	let ok = 0;
	let warn = 0;
	let unknown = 0;
	for (const [title, checks] of groups) {
		lines.push(`## ${title}`);
		lines.push("");
		for (const c of checks) {
			if (c.state === "ok") ok++;
			else if (c.state === "warn") warn++;
			else if (c.state !== "info") unknown++;
			lines.push(`  [${MARKER[c.state]}]  ${c.text}`);
			if (c.detail) lines.push(`          ${c.detail}`);
		}
		lines.push("");
	}
	lines.push("---");
	lines.push("");
	if (warn === 0 && unknown === 0) lines.push(`**${ok} checks passed.** Nothing to do.`);
	else {
		const parts = [`${ok} ok`];
		if (warn > 0) parts.push(`**${warn} needing attention**`);
		if (unknown > 0) parts.push(`**${unknown} NOT VERIFIED**`);
		lines.push(parts.join(", "));
		if (unknown > 0) {
			lines.push("");
			lines.push("> A `????` is a hole in this audit, not a pass. It means the check could not run — which is the same failure mode the audit exists to catch, one level up. Treat it as unresolved, never as \"probably fine\".");
		}
	}
	lines.push("");
	lines.push("*Nothing above was written. This mode only reads.*");
	return lines.join("\n");
}

//#endregion
//#region ../synoptic/src/fragment-resolve.js
/**
* Parse `1.9.0` or `1.0.0-alpha.3` into `[major, minor, patch, ...prerelease]`,
* numeric prerelease identifiers as numbers. Returns null for anything else.
*/
function parseVersion(text) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(String(text ?? "").trim());
	if (m === null) return null;
	const pre = m[4] === void 0 ? [] : m[4].split(".").map((id) => /^\d+$/.test(id) ? Number(id) : id);
	return [
		Number(m[1]),
		Number(m[2]),
		Number(m[3]),
		...pre
	];
}
/**
* Compare two version strings. Unparseable sorts below everything, so a
* malformed directory name can never win a "highest available" contest.
*
* @returns {number} negative if a < b, 0 if equal, positive if a > b.
*/
function compareVersions(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null && pb === null) return 0;
	if (pa === null) return -1;
	if (pb === null) return 1;
	for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
	if (pa.length === 3 || pb.length === 3) return pb.length - pa.length;
	for (let i = 3; i < Math.min(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		if (x === y) continue;
		if (typeof x === "number" && typeof y === "number") return x - y;
		if (typeof x === "number") return -1;
		if (typeof y === "number") return 1;
		return x < y ? -1 : 1;
	}
	return pa.length - pb.length;
}
/**
* Is this repo the SOURCE of the fragment rather than a consumer of it?
*
* synoptic ships `packages/cortext-plugin/fragments/substrate-conventions.md` and
* CLAUDE.md is explicit that when the repo and a plugin cache disagree, the
* repo wins. Installing over it from a cache would discard whatever the working
* tree has that the last release does not — which is exactly the state a repo
* is in while authoring a fragment change.
*
* Detected by the file's presence rather than by repo name, so a fork or a
* rename cannot silently turn the source into a consumer.
*
* @param {{ cwd: string, exists: (p: string) => boolean }} opts
*/
function isFragmentSourceRepo({ cwd, exists }) {
	return exists(`${cwd}/packages/cortext-plugin/fragments/substrate-conventions.md`);
}
/**
* Decide which fragment to install, or refuse and say why.
*
* Pure: every filesystem fact is passed in, so the whole decision table is
* testable without a plugin cache on disk.
*
* @param {object} opts
* @param {ReadonlyArray<{version: string, path: string, origin: string}>} opts.candidates
*   Every fragment this machine could install, already read off disk.
* @param {string|null} opts.installedVersion From `installed_plugins.json`.
* @param {string|null} opts.servedVersion The version that served the skill
*   (`CLAUDE_PLUGIN_ROOT`), for reporting a stale serving root.
* @param {{version: string, digest: string|null}|null} opts.installedFragment
*   The marker currently in the consumer repo, or null when absent.
* @param {boolean} [opts.isSourceRepo=false]
* @returns {{
*   action: 'install'|'current'|'refuse'|'skip-source-repo',
*   chosen: object|null,
*   reason: string|null,
*   report: Array<string>
* }}
*/
function resolveFragmentSource(opts) {
	const { candidates = [], installedVersion = null, servedVersion = null, installedFragment = null, isSourceRepo = false } = opts;
	const report = [];
	const newest = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
	report.push(`installed:      ${installedVersion ?? "(unknown)"}`);
	report.push(`served skill:   ${servedVersion ?? "(unknown)"}` + (servedVersion !== null && installedVersion !== null && compareVersions(servedVersion, installedVersion) < 0 ? "   <- STALE: bound at session start, before the install" : ""));
	report.push(`cache holds:    ${candidates.length} version(s)` + (candidates.length > 0 ? ` (newest ${newest.version}, oldest ${[...candidates].sort((a, b) => compareVersions(a.version, b.version))[0].version})` : ""));
	report.push(`repo has:       ${installedFragment === null ? "(none — not yet a consumer)" : `v${installedFragment.version}+${installedFragment.digest ?? "(no digest)"}`}`);
	if (isSourceRepo) return {
		action: "skip-source-repo",
		chosen: null,
		reason: "this repo SHIPS the fragment (packages/cortext-plugin/fragments/) — its working tree is the authority and may legitimately be ahead of the last release. Installing over it from a plugin cache would discard unreleased edits.",
		report
	};
	if (newest === null) return {
		action: "refuse",
		chosen: null,
		reason: "no fragment found in any plugin directory. Nothing was written — a missing source is a broken install, not a reason to leave the repo untouched silently.",
		report
	};
	const atInstalled = installedVersion === null ? null : candidates.find((c) => compareVersions(c.version, installedVersion) === 0) ?? null;
	const chosen = atInstalled ?? newest;
	if (installedFragment !== null && compareVersions(chosen.version, installedFragment.version) < 0) return {
		action: "refuse",
		chosen: null,
		reason: `the repo already holds v${installedFragment.version}, NEWER than the best available v${chosen.version}. Installing would revert it. This machine's plugin cache is behind whatever produced the repo copy — refresh it rather than overwriting. (If the repo marker is genuinely wrong, delete the file and re-run; an absent copy has nothing to downgrade.)`,
		report
	};
	if (installedVersion !== null && compareVersions(chosen.version, installedVersion) < 0) return {
		action: "refuse",
		chosen: null,
		reason: `the best available fragment is v${chosen.version}, BELOW the installed v${installedVersion}. Installing it would be a downgrade — Step 3's "do not gate on the version being newer" rule is about digests within a version, and must not be read as permission to go backwards. Refresh the plugin cache and re-run.`,
		report
	};
	if (installedVersion !== null && atInstalled === null && compareVersions(newest.version, installedVersion) > 0) report.push(`note:           cache is AHEAD of the install (${newest.version} > ${installedVersion}); using it, but nothing has validated it as this machine’s version`);
	if (installedFragment !== null && installedFragment.digest === chosen.digest) return {
		action: "current",
		chosen,
		reason: null,
		report
	};
	return {
		action: "install",
		chosen,
		reason: null,
		report
	};
}

//#endregion
//#region ../synoptic/src/fragment-drift.js
/** `<!-- substrate-conventions vsynoptic-1.4.1+446ab494 — ... -->` */
const MARKER_RE = /^<!-- substrate-conventions vsynoptic-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+([0-9a-f]{8}))?/;
/**
* Parse line 1's marker.
*
* `digest: null` is a real and distinct answer, not a missing value: markers
* predating the digest suffix (`vsynoptic-0.1.0`) carry a version and nothing to compare content with.
*
* @param {string} text
* @returns {{ version: string, digest: string|null }|null}
*/
function readMarker(text) {
	const match = MARKER_RE.exec(String(text ?? "").split("\n", 1)[0] ?? "");
	if (!match) return null;
	return {
		version: match[1],
		digest: match[2] ?? null
	};
}

//#endregion
//#region ../synoptic/src/fleet-fragments.js
/**
* Split a fragment the way the stamper does: line 1 is the marker, everything
* after it is what the digest covers. Excluding the marker keeps the digest
* from being self-referential.
*
* @returns {{ version: string, claimed: string|null, body: string }|null}
*   null when line 1 is not a marker — a structurally broken file.
*/
function readFragment(text) {
	const s = String(text ?? "");
	const nl = s.indexOf("\n");
	if (nl === -1) return null;
	const m = MARKER_RE.exec(s.slice(0, nl));
	if (m === null) return null;
	return {
		version: m[1],
		claimed: m[2] ?? null,
		body: s.slice(nl + 1)
	};
}
/**
* The comparable form of a hostname. Hostnames differ in case across the fleet
* (`host-a` vs `Host-A`), and a resolver may append a domain.
*/
function normaliseHost(host) {
	return String(host ?? "").trim().toLowerCase().split(".")[0];
}
/**
* Which scanned repos are WORKED ON THIS HOST.
*
* `--fleet` surveys every checkout on local disk, and a disk can hold copies
* nobody works in. A stale scratch tree reported as drifted gets "fixed" while
* the real checkout on another host stays untouched.
*
* The directory already holds the answer: every active `AgentIdentity` row
* carries `project` and `host`. A repo counts only when its project's agent
* runs HERE. A repo worked elsewhere, or claimed by no row, is excluded and
* reported as unknown rather than ok or warn: this box cannot see the copy
* that matters.
*
* An unreadable directory is unknown for the WHOLE host and `here` is empty.
* Falling back to "everything on disk is local" is the defect itself.
*
* Says WHERE a project is worked, not what is installed there.
*
* @param {object} p
* @param {ReadonlyArray<string>} p.repoNames scanned repo dir names (= project)
* @param {string|null} p.thisHost
* @param {ReadonlyArray<{kid?: string, active?: boolean, project?: string|null,
*   host?: string|null}>|null} p.directoryRows null = the directory could not be read
* @returns {{ placed: boolean, here: string[], elsewhere: Array<{name: string, hosts: string[]}>,
*   unclaimed: string[], findings: Array<{id: string, state: string, text: string,
*   detail?: string}> }}
*/
function scopeFleetToHost({ repoNames, thisHost, directoryRows }) {
	const here = [];
	const elsewhere = [];
	const unclaimed = [];
	const findings = [];
	const self = normaliseHost(thisHost);
	if (directoryRows === null || directoryRows === void 0 || self === "") {
		findings.push({
			id: "fleet.population",
			state: "unknown",
			text: self === "" ? "this host's name could not be resolved, so no repo could be placed" : "the AgentIdentity directory could not be read, so no repo could be placed",
			detail: `${repoNames.length} local checkout(s) were NOT surveyed. Which of them are worked on this host is unknown, and surveying them all as local is the failure this check exists to prevent`
		});
		return {
			placed: false,
			here,
			elsewhere,
			unclaimed,
			findings
		};
	}
	const hostsOf = /* @__PURE__ */ new Map();
	for (const r of directoryRows) {
		if (r.active === false || typeof r.project !== "string" || r.project === "") continue;
		const at = typeof r.kid === "string" ? r.kid.lastIndexOf("@") : -1;
		const host = r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
		if (host === null || host === "") continue;
		const set = hostsOf.get(r.project) ?? /* @__PURE__ */ new Map();
		set.set(normaliseHost(host), host);
		hostsOf.set(r.project, set);
	}
	for (const name of repoNames) {
		const hosts = hostsOf.get(name);
		if (hosts === void 0) unclaimed.push(name);
		else if (hosts.has(self)) here.push(name);
		else elsewhere.push({
			name,
			hosts: [...hosts.values()].sort()
		});
	}
	if (elsewhere.length > 0) findings.push({
		id: "fleet.elsewhere",
		state: "unknown",
		text: `${elsewhere.length} local cop${elsewhere.length === 1 ? "y is of a repo" : "ies are of repos"} worked on another host, not counted: ${elsewhere.map((e) => `${e.name} (worked on ${e.hosts.join(", ")})`).join(", ")}`,
		detail: "these local copies are not the ones that matter, and this box cannot see the ones that do. Run --fleet on that host to audit them; do not fix the fragment here"
	});
	if (unclaimed.length > 0) findings.push({
		id: "fleet.unclaimed",
		state: "unknown",
		text: `${unclaimed.length} repo(s) claimed by no active AgentIdentity, not counted: ${unclaimed.join(", ")}`,
		detail: "the directory cannot say where these are worked. Register the agent (or reactivate its row) and they will be placed"
	});
	return {
		placed: true,
		here,
		elsewhere,
		unclaimed,
		findings
	};
}
/**
* Reconcile fragments across repos.
*
* Pure: every file has already been read. `digest` is injected so this module
* needs no node built-ins, matching the other classifiers here.
*
* @param {object} p
* @param {ReadonlyArray<{name: string, text: string|null}>} p.repos
*   One per repo holding a `.claude/substrate-conventions.md`. `text: null` means
*   the file could not be read, which is reported, not skipped.
* @param {string|null} p.best The best available fragment text (the plugin's
*   own copy), or null when it could not be resolved.
* @param {(input: string) => string} p.digest
* @param {{releasedInHistory?: boolean|null, branch?: string|null,
*   defaultBranch?: string|null, behindUpstream?: number|null}} [p.sourceGit]
*   Git facts about the source repo's checkout, read by the caller.
*   `releasedInHistory` is whether the RELEASED body's marker appears anywhere
*   in its history: `false` = a stale clone that never received it, `null` =
*   git could not say. Omitted entirely, nothing is claimed about git.
* @param {{elsewhere: number, unclaimed: number}} [p.population] Set when the
*   repos were scoped to this host; the spread line then states the
*   population it counted and what it left out.
* @param {ReadonlyArray<string>} [p.missing] Repos the directory places on this
*   host that hold NO fragment. Placed means an agent opted in, so these
*   are gaps; the caller leaves unplaced checkouts out.
* @returns {{ rows: Array<object>, findings: Array<{id: string, state: string,
*   text: string, detail?: string}> }}
*/
function auditFleetFragments({ repos, best, digest, sourceRepo = null, sourceGit, population, missing = [] }) {
	const bestFragment = best === null || best === void 0 ? null : readFragment(best);
	const bestDigest = bestFragment === null ? null : digest(bestFragment.body);
	const rows = repos.map(({ name, text, committed }) => {
		const isSource = sourceRepo !== null && name === sourceRepo;
		if (text === null || text === void 0) return {
			name,
			isSource,
			readable: false
		};
		const f = readFragment(text);
		if (f === null) return {
			name,
			isSource,
			readable: true,
			parsed: false
		};
		const computed = digest(f.body);
		return {
			name,
			isSource,
			readable: true,
			parsed: true,
			version: f.version,
			claimed: f.claimed,
			computed,
			markerHonest: f.claimed === null ? null : f.claimed === computed,
			matchesBest: bestDigest === null ? null : computed === bestDigest,
			committed: committed === void 0 || committed === null ? committed : readFragment(committed)
		};
	});
	const findings = [];
	const parsed = rows.filter((r) => r.parsed === true);
	const reposWord = population === void 0 ? "repos" : "repos worked here";
	const left = population === void 0 ? 0 : population.elsewhere + population.unclaimed;
	const leftOut = left === 0 ? "" : ` (${left} local cop${left === 1 ? "y" : "ies"} of repos not worked here not counted)`;
	const unreadable = rows.filter((r) => r.readable === false).map((r) => r.name);
	if (unreadable.length > 0) findings.push({
		id: "fleet.unreadable",
		state: "unknown",
		text: `${unreadable.length} repo fragment(s) could not be read: ${unreadable.join(", ")}`,
		detail: "these are not counted in the spread below, so the spread is a floor"
	});
	if (missing.length > 0) findings.push({
		id: "fleet.missing",
		state: "warn",
		text: `${missing.length} repo(s) worked here have no conventions fragment: ${[...missing].sort().join(", ")}`,
		detail: "each has an active agent on this host, so it opted in and is reading none of the conventions. Run /substrate-setup in each to install the fragment and its CLAUDE.md import"
	});
	const unparsed = rows.filter((r) => r.readable === true && r.parsed !== true).map((r) => r.name);
	if (unparsed.length > 0) findings.push({
		id: "fleet.unparsed",
		state: "warn",
		text: `${unparsed.length} fragment(s) have no marker on line 1: ${unparsed.join(", ")}`,
		detail: "a fragment with no marker cannot be compared or updated by digest — it was hand-created or truncated"
	});
	const byDigest = /* @__PURE__ */ new Map();
	for (const r of parsed) {
		const set = byDigest.get(r.computed) ?? [];
		set.push(r.name);
		byDigest.set(r.computed, set);
	}
	if (byDigest.size > 1) {
		const groups = [...byDigest.entries()].sort((a, b) => b[1].length - a[1].length).map(([d, names]) => `${d}: ${names.join(", ")}`);
		const consumerDigests = new Set(parsed.filter((r) => !r.isSource).map((r) => r.computed));
		const sourceRow = parsed.find((r) => r.isSource) ?? null;
		const onlySourceDiffers = sourceRow !== null && byDigest.size === 2 && consumerDigests.size === 1 && !consumerDigests.has(sourceRow.computed);
		findings.push({
			id: "fleet.spread",
			state: "warn",
			text: `${parsed.length} ${reposWord} hold ${byDigest.size} DISTINCT fragment bodies${leftOut}`,
			detail: onlySourceDiffers ? sourceGit?.releasedInHistory === false ? `every consumer agrees; the difference is ${sourceRow.name}, whose checkout is BEHIND the release — a stale clone of the shipping repo, not a propagation failure. ${groups.join(" | ")}` : `every consumer agrees; the difference is ${sourceRow.name}, which SHIPS the fragment and leads the release until it is published — propagation is not implicated. ${groups.join(" | ")}` : `the propagation mechanism is not reaching every consumer — ${groups.join(" | ")}`
		});
	} else if (parsed.length > 0) findings.push({
		id: "fleet.spread",
		state: "ok",
		text: `all ${parsed.length} ${reposWord} hold the same fragment body${leftOut}`
	});
	const uncommitted = parsed.filter((r) => r.committed !== void 0 && r.committed !== null && digest(r.committed.body) !== r.computed);
	if (uncommitted.length > 0) findings.push({
		id: "fleet.uncommitted",
		state: "warn",
		text: `${uncommitted.length} repo(s) have an UNCOMMITTED fragment: ${uncommitted.map((r) => `${r.name} (working tree ${r.version}, HEAD ${r.committed.version})`).join(", ")}`,
		detail: "the install was never committed, so this audit sees it and a fresh clone does not. Commit the fragment in each — until then the repo an agent works in and the repo the team shares disagree"
	});
	const dishonest = parsed.filter((r) => r.markerHonest === false);
	if (dishonest.length > 0) findings.push({
		id: "fleet.marker",
		state: "warn",
		text: `${dishonest.length} fragment(s) have a marker that does not match their own body: ${dishonest.map((r) => `${r.name} (claims ${r.claimed}, is ${r.computed})`).join(", ")}`,
		detail: "hand-edited or partially written. Every digest comparison against these — including the cold-start drift check — is reading a claim rather than the content"
	});
	if (bestDigest === null) findings.push({
		id: "fleet.current",
		state: "unknown",
		text: "no plugin fragment available to compare against",
		detail: "the spread above is still meaningful — repos disagreeing with each other is a finding regardless of which is right"
	});
	else {
		const behind = parsed.filter((r) => r.matchesBest === false && !r.isSource);
		const sourceAhead = parsed.find((r) => r.isSource && r.matchesBest === false) ?? null;
		if (parsed.filter((r) => !r.isSource).length > 0 || behind.length > 0) findings.push(behind.length === 0 ? {
			id: "fleet.current",
			state: "ok",
			text: `all consumer repos match the available ${bestDigest}`
		} : {
			id: "fleet.current",
			state: "warn",
			text: `${behind.length} consumer repo(s) do not match the available ${bestDigest}: ${behind.map((r) => `${r.name} (${r.version}+${r.computed})`).join(", ")}`,
			detail: "remedy is one command per repo: bin/resolve-fragment.mjs --target-dir <repo> --apply. It refuses a downgrade and skips the repo that ships the fragment"
		});
		const direction = sourceGit?.releasedInHistory;
		if (sourceAhead !== null && direction === false) findings.push({
			id: "fleet.source",
			state: "warn",
			text: `${sourceAhead.name} SHIPS the fragment but its checkout is BEHIND the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed}) — the released body is nowhere in its history`,
			detail: "a stale clone of the shipping repo reads exactly like unpublished work. Pull it, and check out the default branch, before trusting any source-vs-release comparison — until then this tree is not authoritative"
		});
		else if (sourceAhead !== null && direction === null) findings.push({
			id: "fleet.source",
			state: "unknown",
			text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
			detail: "git could not say whether the released body is in its history, so this cannot tell an unpublished edit (ahead) from a stale clone (behind). Check `git log` on the fragment before acting on either reading"
		});
		else if (sourceAhead !== null) findings.push({
			id: "fleet.source",
			state: "ok",
			text: `${sourceAhead.name} SHIPS the fragment and differs from the released ${bestDigest} (${sourceAhead.version}+${sourceAhead.computed})`,
			detail: "expected between editing the fragment and publishing it — its tree is authoritative, so this is the release trailing the source rather than the source drifting. It reaches consumers on the next release + /substrate-setup, and NOT before: a version-only bump leaves the digest unchanged and prompts nobody"
		});
	}
	const sourceName = sourceRepo;
	if (sourceName !== null && sourceGit !== void 0 && sourceGit !== null) {
		const { branch = null, defaultBranch = null, behindUpstream = null } = sourceGit;
		if (typeof behindUpstream === "number" && behindUpstream > 0) findings.push({
			id: "fleet.source-checkout",
			state: "warn",
			text: `${sourceName} checkout is ${behindUpstream} commit(s) behind its upstream${branch ? ` (on ${branch})` : ""}`,
			detail: "every source-side reading in this block is taken from that stale tree. Pull it before trusting them"
		});
		else if (branch !== null && defaultBranch !== null && branch !== defaultBranch) findings.push({
			id: "fleet.source-checkout",
			state: "ok",
			text: `${sourceName} checkout is on ${branch}, not ${defaultBranch} — source-side readings are against that branch`
		});
	}
	return {
		rows,
		findings
	};
}

//#endregion
//#region ../synoptic/src/fs-safe.js
/** A file's utf8 text, or null when absent or unreadable. Never throws. */
function readOrNull(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
/** A directory's entries as Dirents, or null when unreadable. Never throws. */
function listOrNull(path) {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return null;
	}
}

//#endregion
//#region ../synoptic/src/capability.js
/**
* `namespaces` takes two forms. A list of names means `read` on each,
* which is all the authority audit ever checked, so existing capabilities audit
* exactly as before. `{ ns: ['read', 'mutate'] }` declares what the capability
* does to each namespace, so the audit can warn on a key that can read
* somewhere this capability writes. The normalised `namespaces` is always the
* list of names; the per-namespace needs are in `needs`.
*
* @param {{ name: string, namespaces: string[] | Record<string, string[]>,
*           conventions: string, coldStart: (ctx: { project: string }) => string,
*           requiresIdentity?: boolean }} spec
*/
function defineCapability(spec) {
	for (const field of [
		"name",
		"namespaces",
		"conventions",
		"coldStart"
	]) if (spec[field] === void 0) throw new Error(`defineCapability: missing required field '${field}'`);
	const needs = normaliseNeeds(spec.namespaces);
	if (typeof spec.coldStart !== "function") throw new Error("defineCapability: `coldStart` must be a function (ctx) => string");
	return {
		name: spec.name,
		namespaces: Object.keys(needs),
		needs,
		requiresIdentity: spec.requiresIdentity ?? true,
		conventions: spec.conventions,
		coldStart: spec.coldStart
	};
}
/** `namespaces` in either form, as `{ ns: caps }`. Throws on an empty or malformed spec. */
function normaliseNeeds(namespaces) {
	if (Array.isArray(namespaces)) {
		if (namespaces.length === 0) throw new Error("defineCapability: `namespaces` must be a non-empty array or object");
		return Object.fromEntries(namespaces.map((ns) => [ns, ["read"]]));
	}
	if (namespaces === null || typeof namespaces !== "object" || Object.keys(namespaces).length === 0) throw new Error("defineCapability: `namespaces` must be a non-empty array or object");
	for (const [ns, caps] of Object.entries(namespaces)) if (!Array.isArray(caps) || caps.length === 0) throw new Error(`defineCapability: namespace '${ns}' must list at least one capability`);
	return { ...namespaces };
}

//#endregion
//#region ../synoptic/src/capabilities/cortext.js
/**
* Build the cortext capability bound to a coordination `namespace`.
* @param {string} [namespace='cortext'] the qualified-key namespace stem.
*/
function createCortext(namespace = "cortext") {
	const ns = namespace;
	const CONVENTIONS = [
		"## Conventions",
		"",
		`- **Qualified frame keys**: every key is \`<namespace>/<Type>\` — e.g. \`${ns}/Todo\`, \`${ns}/createTodo\`.`,
		"- **Filters live in `where`**: `eq`, `neq`, `gt|gte|lt|lte`, `between`, `in|nin`, `contains`, `startsWith|endsWith`.",
		"  Indexed handle fields (name/title/topic/synopsis/description) filter freely; long-form fields",
		"  (body/summary/notes/rationale) are unindexed — prefer `recall` for prose. `eq: null` never matches.",
		"- **Server-managed metadata**: `createdAt`/`updatedAt`/`createdBy`/`updatedBy` are server-filled —",
		"  never send them on write (rejected); read via the `_metadata` projection.",
		"- **Batched mutations**: an array under one op-key is one atomic transaction; never put the array inside `params`.",
		"- **Write context as it happens**: Decision when one is made; Todo when a gap surfaces (close with",
		"  `archived: true`); SessionLog at every stable milestone (with a retrieval-tuned `synopsis`).",
		"  Per-project rows carry `project` = repo basename; cross-cutting rows use `project: null`."
	].join("\n");
	return defineCapability({
		name: "cortext",
		namespaces: {
			[ns]: ["read", "mutate"],
			recall: ["read", "mutate"]
		},
		requiresIdentity: true,
		conventions: CONVENTIONS,
		coldStart: ({ project }) => [
			`1. \`schema\` — discover types + mutations (the \`${ns}\` namespace).`,
			"2. Query active operational rules and APPLY them silently:",
			"   ```json",
			`   { "${ns}/AgentRule": { "params": { "where": { "active": { "eq": true } } },`,
			"     \"fields\": { \"id\": true, \"rule\": true, \"category\": true, \"rationale\": true } } }",
			"   ```",
			`3. Orient (≤5 lines): open Todos for \`${project}\`, recent \`${ns}/Memory\`, and`,
			"   `recall` for the task at hand.",
			`4. RESUME (cross-agent handoff) — the latest breadcrumb for \`${project}\`:`,
			"   ```json",
			`   { "${ns}/AnchorIntent": { "params": { "where": { "project": { "eq": "${project}" }, "archived": { "eq": false } }, "orderBy": [{ "createdAt": "desc" }], "limit": 1 }, "fields": { "synopsis": true, "body": true, "_metadata": true } } }`,
			"   ```",
			"   If one exists, continue from its `synopsis`/`body` — another agent may have left it.",
			`   When you pause mid-task, leave your own via \`${ns}/createAnchorIntent\` so the next agent resumes.`
		].join("\n")
	});
}
const cortext = createCortext("cortext");

//#endregion
//#region ../synoptic/src/marketplace-pin.js
/** `v1.10.0` -> `1.10.0`; anything else unchanged. */
function stripRefPrefix(ref) {
	const s = String(ref ?? "").trim();
	return s.startsWith("v") ? s.slice(1) : s;
}
/**
* Compare the installed OpenCode skin with the release the marketplace serves.
* The OpenCode skin publishes on the same release as the Claude plugin, so the
* plugin version the marketplace serves is the version the skin should be.
* A null pin is the pin group's hole, so it is not reported again here.
*
* @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
*/
function auditSkin({ pinVersion, opencodeInstalledVersion, compare }) {
	if (pinVersion === null || pinVersion === void 0) return [];
	if (opencodeInstalledVersion === null || opencodeInstalledVersion === void 0) return [{
		id: "skin.installed",
		state: "unknown",
		text: "no opencode skin in the local npm cache, so it cannot be compared to the release",
		detail: "no @mnmal-ai/cortext-opencode under ~/.cache/opencode (node_modules/ or npm/)"
	}];
	const delta = compare(opencodeInstalledVersion, pinVersion);
	if (delta < 0) return [{
		id: "skin.installed",
		state: "warn",
		text: `opencode skin ${opencodeInstalledVersion} is BEHIND the release ${pinVersion}`,
		detail: "update the plugin entry to the release, then restart opencode (config loads once)"
	}];
	if (delta > 0) return [{
		id: "skin.installed",
		state: "warn",
		text: `opencode skin ${opencodeInstalledVersion} is AHEAD of the release ${pinVersion}`,
		detail: "either the marketplace clone is stale, or the install came from outside a release"
	}];
	return [{
		id: "skin.installed",
		state: "ok",
		text: `opencode skin ${opencodeInstalledVersion} matches`
	}];
}
/**
* The newest cortext-opencode version in OpenCode's package cache, or null.
*
* Two layouts, both measured. OpenCode 1.x kept one copy at
* `<cache>/node_modules/@mnmal-ai/cortext-opencode`. OpenCode 2.x keeps one
* per pinned version at `<cache>/npm/@mnmal-ai/cortext-opencode@<v>/<ts>/
* node_modules/@mnmal-ai/cortext-opencode` (measured on OpenCode 2.0.25), and the audit read only
* the first, so every 2.x install reported "no opencode skin". The newest is
* reported because each repo pins its own version; HostInstall rows carry
* what each repo actually loaded.
*
* @param {{ cacheRoot: string, listDir: (d: string) => string[],
*   readFile: (p: string) => string|null, compare: (a: string, b: string) => number }} p
* @returns {string|null}
*/
function newestOpencodeSkin({ cacheRoot, listDir, readFile, compare }) {
	const PKG = [
		"node_modules",
		"@mnmal-ai",
		"cortext-opencode",
		"package.json"
	];
	const join = (...parts) => parts.join("/");
	const versionAt = (path) => {
		try {
			const v = JSON.parse(readFile(path) ?? "null")?.version;
			return typeof v === "string" ? v : null;
		} catch {
			return null;
		}
	};
	const found = [versionAt(join(cacheRoot, ...PKG))];
	const scope = join(cacheRoot, "npm", "@mnmal-ai");
	for (const dir of listDir(scope)) {
		if (!dir.startsWith("cortext-opencode@")) continue;
		for (const ts of listDir(join(scope, dir))) found.push(versionAt(join(scope, dir, ts, ...PKG)));
	}
	const versions = found.filter((v) => v !== null);
	if (versions.length === 0) return null;
	return versions.reduce((a, b) => compare(a, b) >= 0 ? a : b);
}
/**
* Find the cortext pin across every marketplace clone on this machine.
*
* Scans rather than hardcoding `mnmal-ai`, because the marketplace directory is
* named for its owner and a machine may carry several. Returns the first entry
* naming this plugin.
*
* @param {object} p
* @param {string} p.marketplacesDir
* @param {(dir: string) => Array<string>|null} p.listDir
* @param {(path: string) => string|null} p.readFile
* @param {string} [p.pluginName='cortext']
* @returns {{ version: string, ref: string, marketplace: string }|null}
*/
function readMarketplacePin({ marketplacesDir, listDir, readFile, pluginName = "cortext" }) {
	for (const owner of listDir(marketplacesDir) ?? []) {
		const raw = readFile(`${marketplacesDir}/${owner}/.claude-plugin/marketplace.json`);
		if (raw === null) continue;
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		const entry = (parsed?.plugins ?? []).find((p) => p?.name === pluginName);
		if (entry === void 0 || entry === null) continue;
		const ref = entry?.source?.ref ?? null;
		if (ref === null) continue;
		return {
			version: stripRefPrefix(ref),
			ref,
			marketplace: owner
		};
	}
	return null;
}
/**
* Reconcile the pin against what this machine installed.
*
* `cloneFreshness` says what was learned about the local marketplace clone
* relative to its remote. It is THREE-valued on purpose:
*
*   'unchecked'  no network was spent, so the pin reading is a hole
*   'current'    checked, and the clone has everything the remote has
*   'behind'     checked, and the clone is MISSING commits — the pin is stale
*   'ahead'      checked, and the clone carries commits the remote does not
*
* ## Why not a boolean
*
* A `cloneVerified` boolean is false both when nothing was checked AND when a
* check ran and found the clone behind — so the one condition worth catching
* rendered as "not checked against its remote … re-run with --fetch", telling
* the reader to re-run the command that had just produced that line. Same
* shape as the defect in the comment
* below — a check that cannot distinguish "I did not look" from "I looked and
* it is bad" reports the second as the first, which reads as merely untidy.
*
* Unrecognised values fall through to 'unchecked' rather than to 'current': a
* caller that stops passing this, or passes a typo, must degrade to reporting a
* hole, never to claiming health.
*
* @returns {Array<{ id: string, state: 'ok'|'warn'|'unknown', text: string, detail?: string }>}
*/
function auditPin({ pin, installedVersion, cloneFreshness = "unchecked", cloneDetail = null, compare }) {
	const out = [];
	if (pin === null || pin === void 0) {
		out.push({
			id: "pin.read",
			state: "unknown",
			text: "no marketplace pin found",
			detail: "no marketplace clone on this machine names the cortext plugin, so there is nothing to compare the install against — \"am I current?\" cannot be answered locally"
		});
		return out;
	}
	out.push({
		id: "pin.read",
		state: "ok",
		text: `pin ${pin.ref} (marketplace ${pin.marketplace})`
	});
	if (cloneFreshness === "behind") out.push({
		id: "pin.freshness",
		state: "warn",
		text: `the marketplace clone is BEHIND its remote — pin ${pin.ref} is STALE`,
		detail: `${cloneDetail === null ? "" : `${cloneDetail}. `}The pin above is what this clone last fetched, not what the marketplace publishes, so "installed matches the pin" below can be true and still leave this box a release behind. Update the marketplace clone FIRST, then the plugin — a plugin update resolves against the stale pin and correctly does nothing.`
	});
	else if (cloneFreshness === "ahead") out.push({
		id: "pin.freshness",
		state: "warn",
		text: "the marketplace clone is AHEAD of its remote",
		detail: `${cloneDetail === null ? "" : `${cloneDetail}. `}A managed clone carrying unpushed commits means the pin being served here is not the one anyone else resolves.`
	});
	else if (cloneFreshness !== "current") out.push({
		id: "pin.freshness",
		state: "unknown",
		text: "the marketplace clone itself was not checked against its remote",
		detail: "the pin above is whatever this local clone last fetched. A clone two commits behind reports a stale pin as authoritative — which is how a box sat a full release behind while every check said healthy. Re-run with --fetch to verify."
	});
	if (installedVersion === null || installedVersion === void 0) {
		out.push({
			id: "pin.installed",
			state: "unknown",
			text: "installed version unknown, so it cannot be compared to the pin",
			detail: "no cortext@mnmal-ai entry in installed_plugins.json"
		});
		return out;
	}
	const delta = compare(installedVersion, pin.version);
	if (delta < 0) out.push({
		id: "pin.installed",
		state: "warn",
		text: `installed ${installedVersion} is BEHIND the pin ${pin.version}`,
		detail: "the marketplace pin does not update an already-installed plugin — update the plugin, then re-run so the fragment check compares against the right version"
	});
	else if (delta > 0) out.push({
		id: "pin.installed",
		state: "warn",
		text: `installed ${installedVersion} is AHEAD of the pin ${pin.version}`,
		detail: "either this clone is stale, or the install came from somewhere other than the marketplace. Both are worth knowing; neither is silently fine"
	});
	else out.push({
		id: "pin.installed",
		state: "ok",
		text: `installed ${installedVersion} matches`
	});
	return out;
}

//#endregion
//#region ../synoptic/src/mcp-json-facts.js
/**
* A `.mcp.json` env value, reduced to the literal it actually commits to.
*
* Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
* half, because it is the literal a repo commits to when the environment
* supplies nothing. A bare `${VAR}` commits to nothing and answers null — which
* is why an unpinned repo cannot establish its own kid this way.
*/
function mcpEnvLiteral(v) {
	if (typeof v !== "string") return null;
	const m = v.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-([^}]*))?\}$/);
	if (m === null) return v === "" ? null : v;
	return m[1] === void 0 || m[1] === "" ? null : m[1];
}
/**
* Facts about the project `.mcp.json` for the drift check.
*
* Reads the file ONCE and returns only what the check needs: is it tracked,
* and which FIELDS carry machine-specific values. Values never leave this
* function — an env block can hold a token, and the audit's rule is to report
* a field name rather than read a secret into the transcript.
*
* `${VAR:-fallback}` is the interesting case and is not machine-specific by
* itself: the skill's own Step 4.2 form ships `${SUBSTRATE_AGENT_KEY_ID:-default}`,
* whose fallback is the FLEET default. So a kid is flagged only when its
* literal names a host, and a path only when its literal is absolute.
*/
function readMcpJsonFacts(dir, { gitTimeoutMs = 15e3 } = {}) {
	const path = join(dir, ".mcp.json");
	const raw = readOrNull(path);
	if (raw === null) return {
		present: false,
		tracked: null,
		markers: null
	};
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			present: null,
			tracked: null,
			markers: null
		};
	}
	let tracked = null;
	try {
		execFileSync("git", gitArgs(dir), {
			stdio: "ignore",
			timeout: gitTimeoutMs
		});
		tracked = true;
	} catch (e) {
		tracked = trackedFromError(e);
	}
	return {
		present: true,
		tracked,
		markers: markersOf(parsed)
	};
}
function gitArgs(dir) {
	return [
		"-C",
		dir,
		"ls-files",
		"--error-unmatch",
		".mcp.json"
	];
}
function trackedFromError(e) {
	return e?.status === 1 || e?.code === 1 ? false : null;
}
function markersOf(parsed) {
	const markers = [];
	const isAbsolute = (v) => typeof v === "string" && (v.startsWith("/") || v.startsWith("~/"));
	for (const [name, server] of Object.entries(parsed?.mcpServers ?? {})) {
		if (isAbsolute(mcpEnvLiteral(server?.command))) markers.push({
			field: `${name}.command`,
			kind: "absolute path"
		});
		for (const [i, arg] of (Array.isArray(server?.args) ? server.args : []).entries()) if (isAbsolute(mcpEnvLiteral(arg))) markers.push({
			field: `${name}.args[${i}]`,
			kind: "absolute path"
		});
		for (const [k, v] of Object.entries(server?.env ?? {})) {
			const lit = mcpEnvLiteral(v);
			if (lit === null) continue;
			if (/(TOKEN|SECRET|PASSWORD|PASSPHRASE)/i.test(k)) markers.push({
				field: `${name}.env.${k}`,
				kind: "literal secret"
			});
			else if (isAbsolute(lit)) markers.push({
				field: `${name}.env.${k}`,
				kind: "absolute path"
			});
			else if (/(KID|KEY_ID)$/i.test(k) && lit.includes("@")) markers.push({
				field: `${name}.env.${k}`,
				kind: "host-pinned identity"
			});
		}
	}
	return markers;
}

//#endregion
//#region ../synoptic/src/settings-check.js
/**
* @typedef {{ state: 'ok'|'warn'|'unknown', text: string, detail?: string }} SettingsFinding
*/
/**
* Validate the settings file and its MCP-enabling keys.
*
* @param {object} p
* @param {string|null} p.settingsText Raw `.claude/settings.local.json`, or null if absent.
* @param {boolean} p.hasProjectMcp Whether the repo has its own `.mcp.json`.
* @returns {Array<SettingsFinding>}
*/
function checkSettings({ settingsText, hasProjectMcp }) {
	const out = [];
	if (settingsText === null) {
		out.push({
			state: "ok",
			text: "settings.local.json absent (nothing to invalidate)"
		});
		if (hasProjectMcp) out.push({
			state: "warn",
			text: "a project .mcp.json exists with no settings.local.json to enable it",
			detail: "the server needs enableAllProjectMcpServers or enabledMcpjsonServers, or it stays pending approval and presents as \"substrate offline\""
		});
		return out;
	}
	let parsed = null;
	try {
		parsed = JSON.parse(settingsText);
	} catch (err) {
		out.push({
			state: "warn",
			text: "settings.local.json is NOT VALID JSON — Claude Code is silently ignoring all of it",
			detail: `${String(err?.message ?? err)} — every key in this file is inert, including permission allowlists and MCP enablement, while the file reads as though they apply`
		});
		return out;
	}
	out.push({
		state: "ok",
		text: "settings.local.json parses"
	});
	if (!hasProjectMcp) return out;
	const enabledAll = parsed?.enableAllProjectMcpServers === true;
	const enabledList = Array.isArray(parsed?.enabledMcpjsonServers) ? parsed.enabledMcpjsonServers : [];
	if (!enabledAll && !enabledList.includes("substrate")) out.push({
		state: "warn",
		text: "the project .mcp.json substrate server is not enabled by settings.local.json",
		detail: "set enableAllProjectMcpServers: true or add \"substrate\" to enabledMcpjsonServers; until then it stays pending approval and cold-start reports \"substrate offline\""
	});
	else out.push({
		state: "ok",
		text: "project MCP servers are enabled"
	});
	return out;
}

//#endregion
//#region ../synoptic/src/projection-audit.js
/**
* Residue for one response: fields substrate reported as undeclared that the call
* site did not say to expect.
*
* @param {unknown} envelope Parsed /substrate/v1/query response.
* @param {ReadonlyArray<string>} expectUnknown Field names this call site
*   knowingly projects on types that may not declare them.
* @returns {Array<{ key: string, fields: Array<string> }>}
*/
function unexpectedProjections(envelope, expectUnknown = []) {
	const diagnostics = envelope !== null && typeof envelope === "object" ? envelope._diagnostics : null;
	if (diagnostics === null || diagnostics === void 0 || typeof diagnostics !== "object") return [];
	const expected = new Set(expectUnknown);
	const out = [];
	for (const [key, entry] of Object.entries(diagnostics)) {
		const unknown = entry?.unknownProjectionFields;
		if (!Array.isArray(unknown)) continue;
		const residue = unknown.filter((f) => !expected.has(f));
		if (residue.length > 0) out.push({
			key,
			fields: residue
		});
	}
	return out;
}
/**
* Frame keys the request asked for that the response did not answer.
*
* @param {Record<string, unknown>} payload The query frame that was sent.
* @param {unknown} envelope The parsed response.
* @returns {Array<string>}
*/
function unansweredFrames(payload, envelope) {
	if (payload === null || typeof payload !== "object") return [];
	const data = envelope !== null && typeof envelope === "object" ? envelope.data ?? null : null;
	const answered = data !== null && typeof data === "object" ? new Set(Object.keys(data)) : /* @__PURE__ */ new Set();
	return Object.keys(payload).filter((k) => !answered.has(k));
}
/**
* The envelope's `errors`, normalised to `{ key, code, message }`.
*
* `path[0]` is the frame key for a frame-scoped rejection; an error without one
* is envelope-level and reported under '(request)'.
*
* @param {unknown} envelope
* @returns {Array<{ key: string, code: string, message: string }>}
*/
function frameErrors(envelope) {
	const errs = envelope !== null && typeof envelope === "object" ? envelope.errors : null;
	if (!Array.isArray(errs)) return [];
	return errs.map((e) => ({
		key: typeof e?.path?.[0] === "string" ? e.path[0] : "(request)",
		code: typeof e?.code === "string" ? e.code : "error",
		message: typeof e?.message === "string" ? e.message : String(e)
	}));
}

//#endregion
//#region ../synoptic/src/substrate-http.js
const DEFAULT_TIMEOUT_MS = 3e3;
function withTimeout(timeoutMs) {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	return {
		signal: ctl.signal,
		done: () => clearTimeout(t)
	};
}
/**
* POST /substrate/v1/query. Returns the `data` map. Throws on non-2xx / network / timeout.
*
* The return shape deliberately ignores the server's `_diagnostics` sidecar.
* Handing it back
* alongside `data` would churn every caller and, worse, let the projection and
* the statement of what it expects drift apart in different files. Instead the
* call site declares `expectUnknown` right beside its `fields` block, and only
* the residue reaches `onUnexpectedProjection`. See projection-audit.js for why
* the residue — not the raw diagnostic — is the unit of alarm.
*
* `onDiagnostics` is the raw escape hatch, for callers that need the per-type
* unknown sets to do their own cross-type comparison.
*
* `onPagination` receives the server's per-frame `_pagination` map
* (`{ [key]: { hasMore, nextCursor } }`, `{}` when absent). A caller whose
* answer depends on completeness pages on `nextCursor` until `hasMore` is false.
*/
async function substrateQuery(substrateUrl, payload, opts = {}) {
	const { fetchImpl = substrateFetch, timeoutMs = DEFAULT_TIMEOUT_MS, expectUnknown = [], onUnexpectedProjection = null, onDiagnostics = null, onFrameFailure = null, onPagination = null } = opts;
	const { signal, done } = withTimeout(timeoutMs);
	try {
		const res = await fetchImpl(`${substrateUrl}/substrate/v1/query`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal
		});
		if (!res.ok) throw new Error(`substrate/query ${res.status}`);
		const json = await res.json();
		try {
			if (onFrameFailure !== null) {
				for (const e of frameErrors(json)) onFrameFailure(e.key, `${e.code}: ${e.message}`);
				for (const key of unansweredFrames(payload, json)) onFrameFailure(key, "requested but absent from `data`, with no error given");
			}
			if (onDiagnostics !== null) onDiagnostics(json?._diagnostics ?? null);
			if (onUnexpectedProjection !== null) {
				const residue = unexpectedProjections(json, expectUnknown);
				if (residue.length > 0) onUnexpectedProjection(residue);
			}
		} catch {}
		if (onPagination !== null) onPagination(json._pagination ?? {});
		return json.data ?? {};
	} finally {
		done();
	}
}
/**
* Semantic recall. Returns hits[] (`{ id, score }`) when recall answered, or null when it did
* not (semantic unavailable) — the contract callers already depend on.
*
* ## Why this is a frame query and not `POST /substrate/v1/recall`
*
* The kernel route 401s a valid agent token (see `substrateMutate`), and this
* function's own `if (!res.ok) return null` turned that into "semantic
* unavailable". The old comment named the hazard exactly — *"a persistent
* misconfig (e.g. 401) looks the same as a transient gap"* — and then the
* misconfig arrived and looked exactly like a transient gap, every session,
* for as long as the hook has been signing.
*
* `recall/Hit` runs through frame dispatch, which authenticates correctly.
*
* ## Two shape notes that will bite anyone editing this
*
* The frame names the query parameter `to`, not `query`. And a REJECTED frame
* arrives as HTTP 200 with its key absent from `data` — so the null return
* below is driven by key PRESENCE, never by an empty array, which is a true
* negative and must stay distinguishable from a refusal.
*
* `boost` is left unset by default, which means the server's default — ON.
* Recall reinforcing what it MATCHED is the founding "recall what you use"
* signal, and unlike a ranking fetch, the result set here really
* is the evidence. So restoring this restores real salience accumulation on
* Memory / SessionLog / Decision, absent for the same reason. A caller that is
* DIAGNOSING rather than using passes `boost: false` — the audit's probe does,
* because an instrument that reinforces what it matched would alter the signal
* it is reporting on.
*/
async function recall(substrateUrl, opts = {}) {
	const { query, namespace, type, k = 60, threshold, fetchImpl = substrateFetch, timeoutMs = DEFAULT_TIMEOUT_MS, onFrameFailure = null, boost, where } = opts;
	const key = "recall/Hit";
	const params = {
		to: query,
		namespace,
		type,
		k
	};
	if (threshold !== void 0) params.threshold = threshold;
	if (where !== void 0) params.where = where;
	if (boost !== void 0) params.boost = boost;
	try {
		const data = await substrateQuery(substrateUrl, { [key]: {
			params,
			fields: {
				id: true,
				score: true
			}
		} }, {
			fetchImpl,
			timeoutMs,
			onFrameFailure
		});
		if (!Object.hasOwn(data, key)) return null;
		return Array.isArray(data[key]) ? data[key] : null;
	} catch {
		return null;
	}
}
/**
* GET /substrate/v1/whoami — what this credential ACTUALLY holds.
*
* ## Why the server has to be asked
*
* The obvious shortcut is to read our own token, and it does not work.
* `agent-auth.js` mints `ns: ['*'], capabilities: ['read','mutate']` as a fixed
* CLAIM, and substrate intersects that claim with what the kid's _system/Key row
* actually grants. whoami returns the POST-INTERSECTION view — substrate's own
* comment on the route says it exists because *"a caller currently cannot
* distinguish 'my key is registered but scoped to a different namespace' from
* 'the peer is down'"*.
*
* So the one artifact held locally is precisely the one that cannot answer the
* question, because it is the request rather than the grant. A client that
* trusted its own token would report `*` for every identity in the fleet,
* including the one that is scoped to a single namespace and silently losing
* hybrid recall.
*
* ## The shape changed too, and the new field is the valuable half
*
* Old: a bare `authenticated: false` meaning BOTH "this deployment verifies
* nothing" and "auth is on and your credential never arrived". New:
*
*     { authEnabled: boolean, identity: null | { id, capabilities, namespaces } }
*
* Those two states have completely different fixes — a deployment posture the
* caller cannot change, versus env vars that never took effect — and the old
* shape could not express the second at all — and on a reads-open stack, where
* an authenticated read and an anonymous one are byte-identical, that state
* can persist unnoticed.
*
* This function maps the response onto flat `authenticated` / `id` /
* `capabilities` / `namespaces` fields. A response without `authEnabled` maps
* it to `null` — never `false`, which would report a verifying deployment as
* one that verifies nothing.
*
* ## Failure shapes are kept distinct on purpose
*
* The point is that a check which cannot tell "did not ask" from
* "asked, and the answer is bad" reports the second as the first:
*
*   { ok: true,  authEnabled: true,  authenticated: true,  ... }
*                                             the credential answered
*   { ok: true,  authEnabled: false, authenticated: false }
*                                             auth is DISABLED here; nothing is
*                                             verified and presenting a
*                                             credential would change nothing
*   { ok: true,  authEnabled: true,  authenticated: false }
*                                             auth is ON and this request
*                                             carried no credential — OUR
*                                             wiring, not the server's
*   { ok: false, failed: '<reason>' }         unreachable, non-2xx, malformed
*
* A 401 lands in the last with `failed: 'whoami 401'`, and that is a POSITIVE
* signal worth reading: a token was presented and REJECTED. substrate keeps that
* distinct from anonymous deliberately — no token answers 200 with a null
* identity, a bad token 401s — so this is the one case a revoked key produces.
*
* ## `capabilities: null` is now TWO different answers
*
* The grant is two-dimensional: a key holds
* capabilities PER NAMESPACE, `{ cortext: ['read','mutate'], plane: ['read'] }`,
* and `'*'` is a legal key. The flat `capabilities` field survives as a
* compatibility view, and the whoami route sets it to `null` whenever no flat
* list can be honest — the union would say the holder can `mutate` when they
* can only mutate somewhere, and the intersection would under-report.
*
* So a `null` here means EITHER "this response shape is version skew" (the old
* reading, still correct when nothing else arrived) OR "the grant is
* per-namespace, and it is in the field beside this one". Those are opposite
* findings: the first is a hole, the second is a more precise answer than the
* flat field could ever carry. `grants` is what tells them apart, so it is
* carried through rather than dropped — dropping it is what made the audit
* report a correctly-answering 5.23.0 server as a shape it did not understand.
*
* `grants` is `null` when ABSENT, which is its own real state and not a
* failure: substrate attaches it only to a dataset-backed verification, so a
* file-registry key legitimately has none and its flat `capabilities` is the
* whole truth about it.
*
* @returns {Promise<{ ok: boolean, authEnabled?: boolean|null,
*                     authenticated?: boolean, id?: string|null,
*                     capabilities?: string[]|null, namespaces?: string[]|null,
*                     grants?: Record<string, string[]>|null,
*                     failed?: string }>}
*/
async function probeWhoami(substrateUrl, opts = {}) {
	const { fetchImpl = substrateFetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
	const { signal, done } = withTimeout(timeoutMs);
	try {
		const res = await fetchImpl(`${substrateUrl}/substrate/v1/whoami`, { signal });
		if (res.status === 404) return {
			ok: false,
			failed: "whoami 404: this server has no /substrate/v1/whoami route"
		};
		if (!res.ok) return {
			ok: false,
			failed: `whoami ${res.status}`
		};
		const json = await res.json();
		const identity = json?.identity ?? null;
		if (identity === null) return {
			ok: true,
			authEnabled: typeof json?.authEnabled === "boolean" ? json.authEnabled : null,
			authenticated: false
		};
		return {
			ok: true,
			authEnabled: typeof json?.authEnabled === "boolean" ? json.authEnabled : null,
			authenticated: true,
			id: typeof identity.id === "string" ? identity.id : null,
			capabilities: Array.isArray(identity.capabilities) ? identity.capabilities : null,
			namespaces: Array.isArray(identity.namespaces) ? identity.namespaces : null,
			grants: asGrants(identity.grants)
		};
	} catch (e) {
		return {
			ok: false,
			failed: e?.message ?? "whoami unreachable"
		};
	} finally {
		done();
	}
}
/**
* The per-namespace grant, or `null` if this response does not carry one.
*
* Validated rather than trusted, because a HALF-understood grant is worse than
* none: every caller below decides `read` per namespace from this map, so one
* entry arriving as a non-array would either throw mid-render or, worse, read
* as "no capabilities there". Anything not of the exact `{ ns: string[] }`
* shape is rejected WHOLE and falls back to the flat reading, which is the
* behaviour that predates grants and is never wrong — only coarser.
*
* An empty object is deliberately NOT rejected. `intersectGrants` drops a
* namespace that resolves to no capability, so `{}` is the real and reportable
* state of a key whose claim and row share nothing.
*/
function asGrants(raw) {
	if (raw === null || raw === void 0 || typeof raw !== "object" || Array.isArray(raw)) return null;
	const out = {};
	for (const [ns, caps] of Object.entries(raw)) {
		if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) return null;
		out[ns] = caps;
	}
	return out;
}

//#endregion
//#region ../synoptic/src/host-checks.js
/** Non-secret switches whose values are recorded, for fleet-wide drift. */
const SETTINGS_ENV_ALLOWLIST = [
	"SUBSTRATE_URL",
	"SUBSTRATE_NAMESPACE",
	"SYNOPTIC_PROJECT_SCOPE",
	"SYNOPTIC_INBOX_PUSH",
	"SYNOPTIC_INBOX_WAKE",
	"SYNOPTIC_INBOX_URGENT_FROM"
];
/** Identity keys recorded only as set or unset: one holds a key file's path. */
const SETTINGS_ENV_PRESENCE = ["SUBSTRATE_AGENT_KEY_ID", "SUBSTRATE_AGENT_KEY_PATH"];

//#endregion
//#region ../synoptic/src/host-install.js
const HOST_INSTALL_FRESH_MS = 864e5;
const HOST_INSTALL_STALE_MS = 7 * HOST_INSTALL_FRESH_MS;
/**
* fresh < 24h, quiet < 7d, stale beyond, or when refreshedAt is missing or
* unparseable. A future timestamp (clock skew) is fresh with age 0, never a
* negative age.
*
* @returns {{ state: 'fresh'|'quiet'|'stale', ageMs: number|null }}
*/
function classifyInstall(row, nowMs) {
	const t = Date.parse(row?.refreshedAt ?? "");
	if (Number.isNaN(t)) return {
		state: "stale",
		ageMs: null
	};
	const ageMs = Math.max(0, nowMs - t);
	if (ageMs < 864e5) return {
		state: "fresh",
		ageMs
	};
	if (ageMs < 6048e5) return {
		state: "quiet",
		ageMs
	};
	return {
		state: "stale",
		ageMs
	};
}
/** Whole-unit age, for rendering beside a state. */
function describeAge(ageMs) {
	if (ageMs === null || ageMs === void 0) return "never";
	for (const [ms, unit] of [
		[864e5, "day"],
		[36e5, "hour"],
		[6e4, "minute"]
	]) {
		const n = Math.floor(ageMs / ms);
		if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

//#endregion
//#region ../synoptic/src/host-audit.js
const STATE_OF = {
	fresh: "ok",
	quiet: "unknown",
	stale: "warn"
};
const INSTALL_DETAIL = {
	quiet: "no session has started in that repo for over a day, so the row is probably still true but unconfirmed; starting one refreshes it",
	stale: "no session has started there for over a week; do not rely on the row, the host or repo may be gone"
};
const DRIFT_KEYS = [...SETTINGS_ENV_ALLOWLIST.filter((k) => k !== "SYNOPTIC_PROJECT_SCOPE"), ...SETTINGS_ENV_PRESENCE];
const MAX_FIELD = 64;
const MAX_NOTE = 200;
function clean(value, max = MAX_FIELD) {
	if (value === null || value === void 0) return null;
	const text = String(value).replace(/[\p{Cc}`]/gu, " ").trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
const token = (value) => (clean(value) ?? "?").replace(/\s+/g, "_");
const FIELDS = [
	"host",
	"project",
	"kid",
	"harness",
	"pluginVersion",
	"fragmentVersion",
	"fragmentDigest",
	"fragmentState",
	"refreshedAt",
	"pinState",
	"pinNote",
	"mcpJsonState",
	"mcpJsonNote",
	"authorityState",
	"authorityNote",
	"settingsState",
	"settingsNote"
];
const CHECKS = [
	[
		"pin",
		"pin",
		"update the plugin on that host, or refresh its marketplace clone"
	],
	[
		"mcpJson",
		".mcp.json",
		"run audit.mjs in that repo for the detail"
	],
	[
		"authority",
		"authority",
		"the note names which: a key rejected or not loaded, a signer other than the repo kid, a server verifying nothing, or a grant too narrow or too broad. Run audit.mjs in that repo for the fix"
	],
	[
		"settings",
		"settings",
		"fix that repo's .claude/settings.local.json; audit.mjs there has the detail"
	]
];
function cleanRow(row) {
	const out = { _metadata: { updatedBy: { id: clean(row?._metadata?.updatedBy?.id) } } };
	for (const f of FIELDS) out[f] = clean(row?.[f], f.endsWith("Note") ? MAX_NOTE : MAX_FIELD);
	return out;
}
/**
* @param {{ rows: Array<object>|null, directoryRows: Array<object>|null,
*   nowMs: number, compare: (a: string, b: string) => number }} p
*/
function auditHosts({ rows, directoryRows, nowMs, compare }) {
	if (rows === null || directoryRows === null) return [{
		id: "hosts.read",
		state: "unknown",
		text: rows === null ? "HostInstall rows could not be read, so no host was checked" : "the AgentIdentity directory could not be read, so no host was checked",
		detail: "a runtime older than the release that added HostInstall refuses the read. Deploy it, then let one session start in each repo"
	}];
	const matchKey = (host, project) => `${normaliseHost(host)}/${String(project ?? "")}`;
	const shownKey = (host, project) => `${token(normaliseHost(host))}/${token(project)}`;
	const expected = /* @__PURE__ */ new Map();
	const roamers = /* @__PURE__ */ new Map();
	const hostOf = (r) => {
		const at = typeof r.kid === "string" ? r.kid.lastIndexOf("@") : -1;
		return r.host ?? (at > 0 ? r.kid.slice(at + 1) : null);
	};
	for (const r of directoryRows) {
		if (r.active === false || r.roaming !== true || typeof r.kid !== "string") continue;
		const host = hostOf(r);
		if (!host) continue;
		const kids = roamers.get(normaliseHost(host)) ?? /* @__PURE__ */ new Set();
		kids.add(r.kid);
		roamers.set(normaliseHost(host), kids);
	}
	for (const r of directoryRows) {
		if (r.active === false || typeof r.project !== "string" || r.project === "") continue;
		const host = hostOf(r);
		if (!host) continue;
		const match = matchKey(host, r.project);
		const entry = expected.get(match) ?? {
			kids: /* @__PURE__ */ new Set(),
			shown: shownKey(host, r.project)
		};
		if (typeof r.kid === "string") entry.kids.add(r.kid);
		expected.set(match, entry);
	}
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const fresh = [];
	for (const raw of rows) {
		const row = cleanRow(raw);
		const serverAt = Date.parse(raw?._metadata?.updatedAt ?? "");
		const hostAt = Date.parse(raw?.refreshedAt ?? "");
		if (!Number.isNaN(serverAt) && !Number.isNaN(hostAt) && serverAt < hostAt) row.refreshedAt = new Date(serverAt).toISOString();
		const match = matchKey(raw?.host, raw?.project);
		const key = `${shownKey(raw?.host, raw?.project)}/${token(raw?.harness)}`;
		seen.add(match);
		const { state, ageMs } = classifyInstall(row, nowMs);
		out.push({
			id: "hosts.install",
			state: STATE_OF[state],
			text: `${key} ${state} — last reported ${describeAge(ageMs)}: plugin ${row.pluginVersion ?? "?"}, fragment ${row.fragmentVersion ?? "?"}+${row.fragmentDigest ?? "?"} (${row.fragmentState}), ${row.harness}${checkSummary(row)}`,
			...INSTALL_DETAIL[state] ? { detail: INSTALL_DETAIL[state] } : {}
		});
		if (state !== "stale") for (const [field, label, remedy] of CHECKS) {
			if (row[`${field}State`] !== "warn") continue;
			out.push({
				id: "hosts.checks",
				state: "warn",
				text: `${key} ${label}: \`${row[`${field}Note`] ?? "no reason recorded"}\``,
				detail: remedy
			});
		}
		const writer = raw?._metadata?.updatedBy?.id ?? null;
		const rowKid = raw?.kid ?? null;
		const roaming = writer !== null && (roamers.get(normaliseHost(raw?.host))?.has(writer) ?? false);
		const owners = expected.get(match)?.kids ?? new Set(rowKid === null ? [] : [rowKid]);
		const ownerText = [...owners].map((k) => `\`${clean(k)}\``).join(" or ");
		if (roaming) out.push({
			id: "hosts.writer",
			state: "ok",
			text: `${key} was written by \`${clean(writer)}\`, a roaming identity on that host`
		});
		else if (writer === null) out.push({
			id: "hosts.writer",
			state: "unknown",
			text: `${key} carries no _metadata.updatedBy, so who wrote it cannot be checked`,
			detail: "the server stamps updatedBy on every write, so its absence means the read did not project it or the row predates attribution"
		});
		else if (owners.size > 0 && !owners.has(writer)) out.push({
			id: "hosts.writer",
			state: "warn",
			text: `${key} was last written by \`${clean(writer)}\`, not by ${ownerText}, the identity that works it`,
			detail: "a key other than the repo's own reported this host; something may be holding a borrowed key"
		});
		if (!roaming && rowKid !== null && owners.size > 0 && !owners.has(rowKid)) out.push({
			id: "hosts.writer",
			state: "warn",
			text: `${key} names kid \`${clean(rowKid)}\`, but the directory says ${ownerText} works it`,
			detail: "the row or the directory is wrong about which identity works this repo on this host"
		});
		const verified = roaming || writer !== null && expected.has(match) && expected.get(match).kids.has(writer);
		if (state === "fresh" && verified) fresh.push({
			key,
			row,
			harness: raw?.harness ?? null,
			env: raw?.settingsEnv ?? null
		});
		if (!expected.has(match) && !roaming) out.push({
			id: "hosts.orphan",
			state: "unknown",
			text: `${key} reports, but no active AgentIdentity works ${row.project} on ${row.host}`,
			detail: "a retired or unregistered identity is still starting sessions there, or the directory row is wrong"
		});
	}
	for (const [match, { shown }] of expected) {
		if (seen.has(match)) continue;
		out.push({
			id: "hosts.unreported",
			state: "unknown",
			text: `${shown} never reported`,
			detail: "its agent has not started a session on a plugin that reports, or SYNOPTIC_HOST_REPORT=off there, or the directory names the wrong host"
		});
	}
	out.push(...settingsDrift(fresh));
	if (fresh.length > 1) {
		const newest = fresh.map((f) => f.row.pluginVersion).filter(Boolean).sort((a, b) => compare(b, a))[0];
		const digests = /* @__PURE__ */ new Map();
		for (const f of fresh) {
			if (f.row.fragmentState === "source" || !f.row.fragmentDigest) continue;
			digests.set(f.row.fragmentDigest, (digests.get(f.row.fragmentDigest) ?? 0) + 1);
		}
		const commonDigest = [...digests].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
		for (const f of fresh) {
			const pluginBehind = Boolean(newest && f.row.pluginVersion && compare(f.row.pluginVersion, newest) < 0);
			const fragmentOff = Boolean(commonDigest && f.row.fragmentState !== "source" && f.row.fragmentDigest && f.row.fragmentDigest !== commonDigest);
			if (!pluginBehind && !fragmentOff) continue;
			const causes = [];
			const remedies = [];
			if (pluginBehind) {
				causes.push(`plugin ${f.row.pluginVersion} is behind the fleet's ${newest}`);
				remedies.push("run /plugin update cortext@mnmal-ai on that host, then start a session there");
			}
			if (fragmentOff) {
				causes.push(`fragment ${f.row.fragmentVersion ?? "?"}+${f.row.fragmentDigest} differs from the fleet's ${commonDigest}`);
				remedies.push("run /substrate-setup in that repo");
			}
			out.push({
				id: "hosts.versions",
				state: "warn",
				text: `${f.key} ${causes.join("; ")}`,
				detail: remedies.join("; ")
			});
		}
	}
	return out;
}
/** ` · pin ok · authority warn …` for the states a row carries, or ''. */
function checkSummary(row) {
	const parts = CHECKS.filter(([field]) => row[`${field}State`] !== null).map(([field, label]) => `${label} ${row[`${field}State`]}`);
	return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}
/**
* Settings that differ across the fleet. Within each harness (their switches
* legitimately differ), for each recorded switch, the value held by MORE THAN
* HALF of the fresh, verified rows; each row that differs gets a finding. With
* no such majority it reports nothing rather than guessing. Only the known
* switches are compared, and only string or boolean values: the json is
* written by whoever holds a key.
*/
function settingsDrift(fresh) {
	const byHarness = /* @__PURE__ */ new Map();
	for (const f of fresh) {
		if (f.env === null || typeof f.env !== "object" || Array.isArray(f.env)) continue;
		const list = byHarness.get(f.harness) ?? [];
		list.push(f);
		byHarness.set(f.harness, list);
	}
	const show = (v) => {
		if (v === true) return "(set)";
		if (v === false || v === void 0) return "(unset)";
		return typeof v === "string" ? `"${clean(v)}"` : null;
	};
	const out = [];
	for (const rows of byHarness.values()) {
		if (rows.length < 3) continue;
		for (const name of DRIFT_KEYS) {
			const values = rows.map((r) => ({
				key: r.key,
				v: show(r.env[name])
			}));
			if (values.some((x) => x.v === null)) continue;
			const counts = /* @__PURE__ */ new Map();
			for (const { v } of values) counts.set(v, (counts.get(v) ?? 0) + 1);
			const [majority, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
			if (n * 2 <= rows.length) continue;
			for (const { key, v } of values) {
				if (v === majority) continue;
				out.push({
					id: "hosts.settings-drift",
					state: "warn",
					text: `${key} ${name}=${v}, where ${n} of ${rows.length} fresh records have ${majority}`,
					detail: "align that repo's .claude/settings.local.json with the fleet, or record why it differs"
				});
			}
		}
	}
	return out;
}

//#endregion
//#region ../synoptic/src/audit-facts/fleet.js
/**
* The fragment as COMMITTED, which is a different artifact from the one on disk
* wherever it is tracked.
*
* Returns null for "untracked, or not a checkout" — a legitimate state, and
* deliberately the same answer as "git could not tell me", because both mean
* this run has no committed copy to compare against and neither is drift.
* Reporting a hole as a difference would be the defect this check exists for.
*
* @param {string} repoDir
* @returns {string|null}
*/
function committedFragment(repoDir) {
	try {
		return execFileSync("git", [
			"-C",
			repoDir,
			"show",
			"HEAD:.claude/substrate-conventions.md"
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		});
	} catch {
		return null;
	}
}
/** One git answer, or null when git could not give one. */
function gitOut(repoDir, args) {
	try {
		return execFileSync("git", [
			"-C",
			repoDir,
			...args
		], {
			encoding: "utf8",
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			]
		}).trim();
	} catch {
		return null;
	}
}
/**
* Where the SOURCE repo's checkout stands relative to the release.
*
* A source that is ahead of the release made that release, so the released
* marker (`+<digest>`, stamped by sync-fragment-version and enforced against
* the body by test) is in its history. A stale clone never received it. That
* one pickaxe search is what separates "unpublished edit" from "old checkout",
* which read identically from the working tree alone.
*
* `behindUpstream` counts against the LAST FETCH — this runs no network — so it
* can understate. The history check does not depend on it.
*
* @param {string} repoDir
* @param {string|null} releasedDigest
*/
function sourceGitFacts(repoDir, releasedDigest) {
	let releasedInHistory = null;
	if (releasedDigest !== null) {
		const hit = gitOut(repoDir, [
			"log",
			"--all",
			"--format=%H",
			"-1",
			`-S+${releasedDigest}`,
			"--",
			".claude/substrate-conventions.md",
			"packages/cortext-plugin/fragments/substrate-conventions.md"
		]);
		releasedInHistory = hit === null ? null : hit !== "";
	}
	const branch = gitOut(repoDir, [
		"rev-parse",
		"--abbrev-ref",
		"HEAD"
	]);
	const originHead = gitOut(repoDir, [
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD"
	]);
	const behind = gitOut(repoDir, [
		"rev-list",
		"--count",
		"HEAD..@{u}"
	]);
	return {
		releasedInHistory,
		branch: branch === null || branch === "HEAD" ? null : branch,
		defaultBranch: originHead === null ? null : originHead.replace(/^origin\//, ""),
		behindUpstream: behind === null || !/^\d+$/.test(behind) ? null : Number(behind)
	};
}
const HOST_INSTALL_LIMIT = 500;
const HOST_INSTALL_FIELDS = [
	"key",
	"host",
	"hostReported",
	"project",
	"kid",
	"harness",
	"pluginVersion",
	"fragmentVersion",
	"fragmentDigest",
	"fragmentState",
	"refreshedAt",
	"pinState",
	"pinNote",
	"mcpJsonState",
	"mcpJsonNote",
	"authorityState",
	"authorityNote",
	"settingsState",
	"settingsNote",
	"settingsEnv"
];
/**
* `fleetFindings` is null without --fleet; `hostFindings` is null without
* --fleet or --hosts.
*
* @param {{ fleetDir: string|null, hosts?: boolean, directoryRows: Array<object>|null,
*           candidates: Array<{ version: string, text: string }>,
*           substrateUrl: string|null, env: Record<string, string|undefined>,
*           fetchImpl: typeof fetch, thisHost?: string }} p
*/
async function gatherFleet({ fleetDir, hosts = false, directoryRows, candidates, substrateUrl, env, fetchImpl, thisHost = hostname() }) {
	let fleetFindings = null;
	let hostFindings = null;
	if (fleetDir !== null) {
		const repos = [];
		const sourceRepos = [];
		const noFragment = [];
		for (const d of (listOrNull(fleetDir) ?? []).filter((e) => e.isDirectory())) {
			const dir = join(fleetDir, d.name);
			const f = join(dir, ".claude", "substrate-conventions.md");
			if (!existsSync(f)) {
				noFragment.push(d.name);
				continue;
			}
			if (isFragmentSourceRepo({
				cwd: dir,
				exists: existsSync
			})) sourceRepos.push(d.name);
			repos.push({
				name: d.name,
				text: readOrNull(f),
				committed: committedFragment(dir)
			});
		}
		const scope = scopeFleetToHost({
			repoNames: repos.map((r) => r.name),
			thisHost,
			directoryRows
		});
		const here = new Set(scope.here);
		const missing = scopeFleetToHost({
			repoNames: noFragment,
			thisHost,
			directoryRows
		}).here;
		const scoped = repos.filter((r) => here.has(r.name));
		const localSource = sourceRepos.find((name) => here.has(name)) ?? null;
		const bestText = [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0]?.text ?? null;
		const digest = (body) => createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8);
		const bestFragment = bestText === null ? null : readFragment(bestText);
		const surveyed = !scope.placed ? [] : auditFleetFragments({
			repos: scoped,
			best: bestText,
			sourceRepo: localSource,
			sourceGit: localSource === null ? void 0 : sourceGitFacts(join(fleetDir, localSource), bestFragment === null ? null : digest(bestFragment.body)),
			digest,
			population: {
				elsewhere: scope.elsewhere.length,
				unclaimed: scope.unclaimed.length
			},
			missing
		}).findings;
		fleetFindings = [...scope.findings, ...surveyed].map((f) => check(f.id, f.state, f.text, f.detail));
	}
	if (fleetDir !== null || hosts) {
		let hostRows = null;
		if (substrateUrl !== null) try {
			const key = `${env.SUBSTRATE_NAMESPACE ?? "cortext"}/HostInstall`;
			const fields = { _metadata: true };
			for (const f of HOST_INSTALL_FIELDS) fields[f] = true;
			const data = await substrateQuery(substrateUrl, { [key]: {
				params: { limit: HOST_INSTALL_LIMIT },
				fields
			} }, { fetchImpl });
			hostRows = Object.hasOwn(data, key) ? data[key] : null;
		} catch {
			hostRows = null;
		}
		hostFindings = auditHosts({
			rows: hostRows,
			directoryRows,
			nowMs: Date.now(),
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail));
		if (hostRows !== null && hostRows.length >= HOST_INSTALL_LIMIT) hostFindings.push(check("hosts.truncated", "unknown", `read ${hostRows.length} HostInstall rows, the query limit, so some may be missing`, "\"never reported\" findings above may be false; this audit does not page"));
	}
	return {
		fleetFindings,
		hostFindings
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/server.js
const DIRECTORY_LIMIT = 200;
/**
* The AgentIdentity directory. All three are null when there is no server or
* it did not answer: `unknown`, never "unregistered".
*/
async function readDirectory({ substrateUrl, env, fetchImpl }) {
	let directoryKids = null;
	let directoryRows = null;
	let activeKids = null;
	if (substrateUrl !== null) try {
		const key = `${env.SUBSTRATE_NAMESPACE ?? "cortext"}/AgentIdentity`;
		const fields = {
			kid: true,
			active: true,
			description: true,
			project: true,
			host: true
		};
		const readDirectory = (f) => substrateQuery(substrateUrl, { [key]: {
			params: { limit: 200 },
			fields: f
		} }, { fetchImpl });
		let data = await readDirectory({
			...fields,
			roaming: true
		});
		if (!Object.hasOwn(data, key)) data = await readDirectory(fields);
		directoryRows = Object.hasOwn(data, key) ? data[key] : null;
		directoryKids = directoryRows === null ? null : directoryRows.map((r) => r.kid);
		activeKids = directoryRows === null ? null : directoryRows.filter((r) => r.active !== false).map((r) => r.kid);
	} catch {
		directoryKids = null;
	}
	return {
		directoryRows,
		directoryKids,
		activeKids
	};
}
/**
* whoami plus the recall probe, read-only. Without a server each answers
* `unknown` with the reason.
*
* @param {{ substrateUrl: string|null, env: Record<string, string|undefined>,
*           fetchImpl: typeof fetch, kid: string|null,
*           declaredKid?: string|null }} p
*/
async function probeServer({ substrateUrl, env, fetchImpl, kid, declaredKid = null }) {
	let recallFindings = [check("recall.available", "unknown", "SUBSTRATE_URL is not set, so semantic recall could not be probed", "the audit cannot reach a server to ask whether recall answers")];
	let whoami = {
		ok: false,
		failed: "SUBSTRATE_URL is not set, so the server could not be asked"
	};
	if (substrateUrl !== null) {
		const ns = env.SUBSTRATE_NAMESPACE ?? "cortext";
		whoami = await probeWhoami(substrateUrl, { fetchImpl });
		const reachable = whoami.ok || /^whoami \d/.test(whoami.failed ?? "");
		let recallReason = null;
		const rows = await recall(substrateUrl, {
			query: "audit probe: is semantic recall reachable",
			namespace: ns,
			type: "Memory",
			k: 1,
			boost: false,
			fetchImpl,
			onFrameFailure: (k, d) => recallReason = `${k}: ${d}`
		});
		recallFindings = auditSemanticRecall({
			answered: rows !== null,
			credentialAttributed: credentialIsTargets({
				whoami,
				resolvedKid: kid,
				declaredKid
			}),
			reachable,
			reason: recallReason ?? (reachable ? "the recall frame did not answer and gave no reason" : whoami.failed)
		});
	}
	return {
		whoami,
		recallFindings
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/groups.js
/** @param {Record<string, any>} facts every gatherer's output, plus the target and cwd. */
function buildGroups(facts) {
	const { pin, installedVersion, cloneFreshness, cloneDetail, opencodeSkinVersion, installedRegistry, candidates, cacheDirState, servedVersion, servedRootState, resolution, kid, source, declaredName, declaredKid, keyNames, revokedNames, directoryKids, activeKids, directoryRows, whoami, authWarning, targetDir, cwd, env, keyRefs, refScanComplete, mcpJsonFacts, recallFindings, settingsFindings, fleetFindings, hostFindings } = facts;
	return [
		["pin", auditPin({
			pin,
			installedVersion,
			cloneFreshness,
			cloneDetail,
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail))],
		["skins", auditSkin({
			pinVersion: pin?.version ?? null,
			opencodeInstalledVersion: opencodeSkinVersion,
			compare: compareVersions
		}).map((f) => check(f.id, f.state, f.text, f.detail))],
		["plugin", auditPlugin({
			installedVersion,
			installedRegistry,
			cacheVersions: candidates.map((c) => c.version),
			cacheDir: cacheDirState,
			servedVersion,
			servedRoot: servedRootState,
			compare: compareVersions
		})],
		["fragment", auditFragment(resolution)],
		["identity", auditIdentity({
			resolvedKid: kid,
			source,
			declaredName,
			keyFilePresent: keyNames === null || kid === null ? null : keyNames.includes(kid.split("@")[0]),
			directoryKids
		})],
		["authority", auditAuthority({
			whoami,
			declaredKid,
			selfAudit: targetDir === cwd,
			authWarning,
			expectedNamespaces: createCortext(env.SUBSTRATE_NAMESPACE ?? "cortext").namespaces,
			expectedCapabilities: createCortext(env.SUBSTRATE_NAMESPACE ?? "cortext").needs,
			resolvedKid: kid
		})],
		["drift", [...auditOrphans({
			keyNames,
			revokedNames,
			directoryKids,
			activeKids,
			directoryRows,
			keyRefs,
			refScanComplete
		}), ...directoryRows !== null && directoryRows.length >= 200 ? [check("directory.truncated", "unknown", `read ${directoryRows.length} AgentIdentity rows, the query limit, so some may be missing`, "\"unregistered\" and \"never reported\" findings may be false; this audit does not page")] : []]],
		["mcp-json", auditMcpJson(mcpJsonFacts)],
		["inbox push", auditInboxPush({ env })],
		["recall", recallFindings],
		["settings", settingsFindings],
		...fleetFindings === null ? [] : [["fleet", fleetFindings]],
		...hostFindings === null ? [] : [["hosts", hostFindings]]
	];
}

//#endregion
//#region ../synoptic/src/audit-facts/identity.js
/**
* The signing identity of the MCP server serving THIS repo.
*
* ## Read this before touching it
*
* It must not come from `process.env`. The auditing shell can carry no
* `SUBSTRATE_AGENT_KEY_ID` while the MCP child does, because `.mcp.json`
* supplies it per-server. An audit reading its own environment reports "no
* identity" on a correctly configured box — a false negative that would send
* someone off to re-provision a working identity.
*
* ## And why it extracts ONE variable instead of dumping
*
* `/proc/<pid>/environ` carries `SUBSTRATE_AGENT_KEY_PATH` and `SUBSTRATE_DATABASE_URL`
* beside the kid. Dumping it and filtering the output afterwards has already
* leaked a live Postgres password in this fleet, because the filter masked the
* patterns someone had thought of and not the one they had not. So this reads
* the buffer, pulls out exactly the two names it needs, returns the kid and a
* BOOLEAN for the key, and never returns or logs anything else.
*
* `/proc` is Linux-only. Elsewhere this returns nulls, which surface as
* `unknown` — not as "no identity".
*/
function resolveIdentityFromMcp(targetDir) {
	const procs = listOrNull("/proc");
	if (procs === null) return {
		kid: null,
		keyEnvSet: null,
		source: null
	};
	for (const d of procs) {
		if (!/^\d+$/.test(d.name)) continue;
		let cwd = null;
		try {
			if (!readFileSync(`/proc/${d.name}/cmdline`, "utf8").includes("substrate")) continue;
			cwd = readlinkSync(`/proc/${d.name}/cwd`);
		} catch {
			continue;
		}
		if (cwd !== targetDir) continue;
		const raw = readOrNull(`/proc/${d.name}/environ`);
		if (raw === null) continue;
		let kid = null;
		let keyEnvSet = false;
		for (const entry of raw.split("\0")) if (entry.startsWith("SUBSTRATE_AGENT_KEY_ID=")) kid = entry.slice(23);
		else if (entry.startsWith("SUBSTRATE_AGENT_KEY_PATH=")) keyEnvSet = true;
		if (kid !== null) return {
			kid,
			keyEnvSet,
			source: `mcp server pid ${d.name}`
		};
	}
	return {
		kid: null,
		keyEnvSet: null,
		source: null
	};
}
/**
* The kid the TARGET repo pins for itself.
*
* First `.mcp.json` (a literal `SUBSTRATE_AGENT_KEY_ID` — never a `${VAR}` ref, which
* commits to nothing), then the repo's own `.claude/settings.local.json`
* `env`. Both are DECLARATIONS, not measurements — they say which identity
* the repo intends to sign as, which is enough to reject a grant read under
* someone else's credential and not enough to prove the key on disk matches.
* The settings file matters because the post-shell-carrier `.mcp.json` names
* no identity at all: it inherits settings `env` at spawn, and without this
* fallback a plain-shell audit of such a repo could never name its subject.
* Two sources naming different kids is ambiguous, so it answers null rather
* than picking one.
*/
function readDeclaredKid(targetDir) {
	let parsed = null;
	try {
		parsed = JSON.parse(readOrNull(join(targetDir, ".mcp.json")) ?? "null");
	} catch {
		parsed = null;
	}
	const kids = /* @__PURE__ */ new Set();
	for (const server of Object.values(parsed?.mcpServers ?? {})) {
		const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
		if (kid !== null) kids.add(kid);
	}
	if (kids.size > 1) return null;
	if (kids.size === 1) return [...kids][0];
	const settingsRaw = readOrNull(join(targetDir, ".claude", "settings.local.json"));
	if (settingsRaw === null) return null;
	try {
		const kid = JSON.parse(settingsRaw)?.env?.SUBSTRATE_AGENT_KEY_ID;
		return typeof kid === "string" && kid !== "" ? kid : null;
	} catch {
		return null;
	}
}
/** The repo's declared agent name, when it carries one. */
function readDeclaredName(targetDir) {
	const raw = readOrNull(join(targetDir, ".claude", "settings.json"));
	if (raw === null) return null;
	try {
		return JSON.parse(raw)?.env?.SYNOPTIC_AGENT_NAME ?? null;
	} catch {
		return null;
	}
}
/** Live and revoked key names in `keysDir`; both null when it cannot be read. */
function readKeyFiles(keysDir) {
	const keyEntries = listOrNull(keysDir);
	return {
		keyNames: keyEntries === null ? null : keyEntries.filter((f) => f.name.endsWith(".key")).map((f) => f.name.replace(/\.key$/, "")),
		revokedNames: keyEntries === null ? null : keyEntries.filter((f) => f.name.endsWith(".key.revoked")).map((f) => f.name.replace(/\.key\.revoked$/, ""))
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/key-refs.js
/**
* Which key files are actually SIGNED WITH, and under which kid.
*
* A key file's name is not its identity. `claude-agent.key` signs as
* `claude-code@host-a`, and the only place that binding is written down is
* the `.mcp.json` that configures the pair — so that is what has to be read
* before calling a key unowned.
*
* Handles both `${VAR}` and `${VAR:-fallback}`: the fallback is the interesting
* half, because it is the literal a repo commits to when the environment
* supplies nothing.
*
* @param {ReadonlyArray<string>} files absolute paths to candidate .mcp.json
* @returns {Array<{ keyName: string, kid: string, source: string }>}
*/
function scanKeyRefs(files) {
	const refs = [];
	for (const f of files) {
		const raw = readOrNull(f);
		if (raw === null) continue;
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}
		for (const server of Object.values(parsed?.mcpServers ?? {})) {
			const keyPath = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_PATH);
			const kid = mcpEnvLiteral(server?.env?.SUBSTRATE_AGENT_KEY_ID);
			if (keyPath === null || kid === null) continue;
			const keyName = (keyPath.split("/").pop() ?? "").replace(/\.(key|pub)$/, "");
			if (keyName !== "") refs.push({
				keyName,
				kid,
				source: f
			});
		}
	}
	return refs;
}
/** @param {{ fleetDir: string|null, targetDir: string, home: string }} p */
function gatherKeyRefs({ fleetDir, targetDir, home }) {
	const refScanDirs = fleetDir === null ? [targetDir] : (listOrNull(fleetDir) ?? []).filter((e) => e.isDirectory()).map((e) => join(fleetDir, e.name));
	const systemdUserDir = join(home, ".config", "systemd", "user");
	const systemdUnits = (listOrNull(systemdUserDir) ?? []).filter((e) => e.name.endsWith(".service")).map((e) => join(systemdUserDir, e.name));
	return {
		keyRefs: [
			...scanKeyRefs(refScanDirs.map((d) => join(d, ".mcp.json"))),
			...scanMiseRefs(refScanDirs.map((d) => ({
				path: join(d, "mise.toml"),
				text: readOrNull(join(d, "mise.toml"))
			}))),
			...scanCodexRefs(refScanDirs.map((d) => {
				const path = join(d, ".codex", "cortext.local.json");
				return {
					path,
					text: readOrNull(path)
				};
			})),
			...scanSystemdRefs(systemdUnits.map((path) => ({
				path,
				text: readOrNull(path)
			})))
		],
		refScanComplete: fleetDir !== null
	};
}

//#endregion
//#region ../synoptic/src/audit-facts/pin.js
/** @param {{ pluginsDir: string, fetch: boolean }} p `fetch` verifies the clone against its remote. */
function readPinFacts({ pluginsDir, fetch }) {
	const marketplacesDir = join(pluginsDir, "marketplaces");
	const pin = readMarketplacePin({
		marketplacesDir,
		listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
		readFile: readOrNull
	});
	let cloneFreshness = "unchecked";
	let cloneDetail = null;
	if (fetch === true && pin !== null) try {
		const clone = join(marketplacesDir, pin.marketplace);
		const git = (...args) => execFileSync("git", [
			"-C",
			clone,
			...args
		], {
			encoding: "utf8",
			timeout: 15e3
		}).trim();
		execFileSync("git", [
			"-C",
			clone,
			"fetch",
			"--quiet"
		], {
			timeout: 15e3,
			stdio: "ignore"
		});
		const behind = Number(git("rev-list", "--count", "HEAD..@{u}"));
		const ahead = Number(git("rev-list", "--count", "@{u}..HEAD"));
		const local = git("rev-parse", "--short", "HEAD");
		const remote = git("rev-parse", "--short", "@{u}");
		if (behind > 0) {
			cloneFreshness = "behind";
			cloneDetail = `local ${local}, remote ${remote} — ${behind} commit(s) behind` + (ahead > 0 ? ` and ${ahead} ahead (diverged)` : "");
		} else if (ahead > 0) {
			cloneFreshness = "ahead";
			cloneDetail = `local ${local}, remote ${remote} — ${ahead} commit(s) ahead`;
		} else cloneFreshness = "current";
	} catch {
		cloneFreshness = "unchecked";
		cloneDetail = null;
	}
	return {
		marketplacesDir,
		pin,
		cloneFreshness,
		cloneDetail
	};
}
/** @param {{ home: string }} p */
function readSkinFacts({ home }) {
	return { opencodeSkinVersion: newestOpencodeSkin({
		cacheRoot: join(home, ".cache", "opencode"),
		listDir: (d) => (listOrNull(d) ?? []).filter((e) => e.isDirectory()).map((e) => e.name),
		readFile: readOrNull,
		compare: compareVersions
	}) };
}

//#endregion
//#region ../synoptic/src/audit-facts/plugin.js
/**
* @param {{ pluginsDir: string, cacheDir: string, targetDir: string,
*           envRoot: string|null, selfRoot: string }} p
*   `envRoot` is CLAUDE_PLUGIN_ROOT when set; `selfRoot` is the plugin root
*   this audit is running from.
*/
function gatherPluginFacts({ pluginsDir, cacheDir, targetDir, envRoot, selfRoot }) {
	let installedVersion = null;
	let installedRegistry = "unreadable";
	try {
		const e = JSON.parse(readFileSync(join(pluginsDir, "installed_plugins.json"), "utf8"))?.plugins?.["cortext@mnmal-ai"];
		if (!Array.isArray(e) || e.length === 0) installedRegistry = "no-entry";
		else {
			installedVersion = e[0].version ?? null;
			installedRegistry = installedVersion === null ? "malformed" : "present";
		}
	} catch {
		installedRegistry = "unreadable";
	}
	const cacheListing = listOrNull(cacheDir);
	const cacheDirState = cacheListing === null ? "unreadable" : "readable";
	const cacheEntries = cacheListing ?? [];
	const candidates = [];
	for (const d of cacheEntries) {
		if (!d.isDirectory()) continue;
		const text = readOrNull(join(cacheDir, d.name, "fragments", "substrate-conventions.md"));
		if (text === null) continue;
		const m = readMarker(text);
		candidates.push({
			version: m?.version ?? d.name,
			digest: m?.digest ?? null,
			origin: `cache/${d.name}`,
			text
		});
	}
	const servedRoot = envRoot ?? selfRoot;
	const servedRootState = envRoot !== null ? "set" : selfRoot.startsWith(`${cacheDir}/`) ? "derived-cache" : "derived-source";
	const servedVersion = readMarker(readOrNull(join(servedRoot, "fragments", "substrate-conventions.md")) ?? "")?.version ?? null;
	const repoFragment = readMarker(readOrNull(join(targetDir, ".claude", "substrate-conventions.md")) ?? "");
	const resolution = resolveFragmentSource({
		candidates,
		installedVersion,
		servedVersion,
		installedFragment: repoFragment,
		isSourceRepo: isFragmentSourceRepo({
			cwd: targetDir,
			exists: existsSync
		})
	});
	return {
		installedVersion,
		installedRegistry,
		cacheDirState,
		candidates,
		servedVersion,
		servedRootState,
		resolution
	};
}

//#endregion
//#region ../synoptic/src/local-env.js
/** Settings keys a hook may inherit repo-locally. Everything else stays shell-only. */
const LOCAL_ENV_KEYS = [
	"SUBSTRATE_URL",
	"SUBSTRATE_NAMESPACE",
	"SUBSTRATE_AGENT_KEY_ID",
	"SUBSTRATE_AGENT_KEY_PATH",
	"SUBSTRATE_AGENT_CAPABILITIES",
	"SYNOPTIC_AGENT_NAMESPACES",
	"SYNOPTIC_PROJECT_SCOPE",
	"SYNOPTIC_COLD_START_MAX_BYTES",
	"SYNOPTIC_INBOX_STOP_CHECK",
	"SYNOPTIC_INBOX_PROMPT_CHECK",
	"SYNOPTIC_INBOX_PUSH",
	"SYNOPTIC_INBOX_WAKE",
	"SYNOPTIC_INBOX_URGENT_FROM"
];
/**
* The repo-local env overlay: `{ env, source }`.
*
* @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
* @returns {{ env: Record<string,string>, source: string|null }}
*   `source` is the settings path the overlay came from, or null when there
*   is none (absent/unparsable/no env object — all the same observation).
*/
function readLocalEnv({ targetDir, readFile = readOrNull }) {
	const source = join(targetDir, ".claude", "settings.local.json");
	let raw = null;
	try {
		raw = readFile(source);
	} catch {
		return {
			env: {},
			source: null
		};
	}
	if (raw === null) return {
		env: {},
		source: null
	};
	let parsed = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			env: {},
			source: null
		};
	}
	const block = parsed?.env;
	if (block === null || typeof block !== "object" || Array.isArray(block)) return {
		env: {},
		source: null
	};
	const env = {};
	for (const key of LOCAL_ENV_KEYS) {
		const v = block[key];
		if (typeof v === "string" && v !== "") env[key] = v;
	}
	return {
		env,
		source: Object.keys(env).length === 0 ? null : source
	};
}
/**
* Merge process env over the repo-local overlay. Process env always wins —
* an explicitly exported value is a choice, and the fallback must never
* silently replace one.
*
* @param {Record<string,string|undefined>} processEnv
* @param {{ targetDir: string, readFile?: (path: string) => string|null }} p
* @returns {{ env: Record<string,string|undefined>, source: string|null, filled: string[] }}
*   `filled` names the keys the overlay supplied, so callers can report it.
*/
function envWithLocalFallback(processEnv, { targetDir, readFile = readOrNull }) {
	const { env: local, source } = readLocalEnv({
		targetDir,
		readFile
	});
	if (source === null) return {
		env: processEnv,
		source: null,
		filled: []
	};
	const env = { ...processEnv };
	const filled = [];
	for (const [k, v] of Object.entries(local)) if (env[k] === void 0 || env[k] === "") {
		env[k] = v;
		filled.push(k);
	}
	return {
		env,
		source,
		filled: filled.length === 0 ? [] : filled
	};
}

//#endregion
//#region ../synoptic/src/repo-root.js
/** Owner uid of `path`, or null when it does not exist. */
function ownerOf(path) {
	try {
		return statSync(path).uid;
	} catch {
		return null;
	}
}
/**
* The nearest ancestor of `start` (itself included) holding `.git`, a
* directory in a checkout or a file in a worktree. Null outside any
* repository, and never throws.
*
* The root's settings decide which server this session signs to, so a root
* is accepted only when it and its `.git` belong to the current user, the
* same rule as git's safe.directory: a `.git` planted in a shared ancestor
* such as /tmp must not be able to adopt a session. The walk stops at the
* nearest `.git` either way.
*
* @param {string} start
* @param {{ ownerOf?: (path: string) => number|null, uid?: number|null }} [io]
* @returns {string|null}
*/
function findRepoRoot(start, io = {}) {
	if (!start) return null;
	const owner = io.ownerOf ?? ownerOf;
	const uid = io.uid !== void 0 ? io.uid : process.getuid?.() ?? null;
	try {
		let dir = start;
		for (;;) {
			const gitOwner = owner(join(dir, ".git"));
			if (gitOwner !== null) {
				if (uid === null) return dir;
				return gitOwner === uid && owner(dir) === uid ? dir : null;
			}
			const parent = dirname(dir);
			if (parent === dir) return null;
			dir = parent;
		}
	} catch {
		return null;
	}
}

//#endregion
//#region ../synoptic/src/scope.js
/** The repository root for a session started in `start`, or `start` itself outside one. */
function sessionRoot(start) {
	return findRepoRoot(start) ?? start;
}

//#endregion
//#region ../synoptic/src/audit-entry.js
const BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["fetch", "hosts"]);
function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const name = argv[i].slice(2);
		flags[name] = BOOLEAN_FLAGS.has(name) ? true : argv[++i];
	}
	return flags;
}
const flags = parseArgs(process.argv.slice(2));
const requestedDir = (() => {
	const dir = resolve(flags["target-dir"] ?? process.cwd());
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
})();
const targetDir = sessionRoot(requestedDir);
const pluginsDir = flags["plugins-dir"] ?? join(homedir(), ".claude", "plugins");
const cacheDir = join(pluginsDir, "cache", "mnmal-ai", "cortext");
const keysDir = join(homedir(), ".config/substrate/keys");
const envRoot = process.env.CLAUDE_PLUGIN_ROOT ?? null;
const selfRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = gatherPluginFacts({
	pluginsDir,
	cacheDir,
	targetDir,
	envRoot,
	selfRoot
});
const { kid, source } = resolveIdentityFromMcp(targetDir);
const { keyNames, revokedNames } = readKeyFiles(keysDir);
const { env } = envWithLocalFallback(process.env, { targetDir });
const substrateUrl = env.SUBSTRATE_URL ?? null;
const agentAuth = createAgentAuth(env);
const fetchImpl = makeSignedFetch(agentAuth.getAuthHeader);
const directory = await readDirectory({
	substrateUrl,
	env,
	fetchImpl
});
const authWarning = agentAuth.warning;
const declaredKid = readDeclaredKid(targetDir);
const server = await probeServer({
	substrateUrl,
	env,
	fetchImpl,
	kid,
	declaredKid
});
const settingsFindings = checkSettings({
	settingsText: readOrNull(join(targetDir, ".claude", "settings.local.json")),
	hasProjectMcp: existsSync(join(targetDir, ".mcp.json"))
}).map((f, i) => check(`settings.${i}`, f.state, f.text, f.detail));
const pinFacts = readPinFacts({
	pluginsDir,
	fetch: flags.fetch === true
});
const fleetDir = flags.fleet ?? null;
const fleet = await gatherFleet({
	fleetDir,
	hosts: flags.hosts === true,
	directoryRows: directory.directoryRows,
	candidates: plugin.candidates,
	substrateUrl,
	env,
	fetchImpl
});
const refs = gatherKeyRefs({
	fleetDir,
	targetDir,
	home: homedir()
});
const skins = readSkinFacts({ home: homedir() });
const groups = buildGroups({
	...plugin,
	kid,
	source,
	declaredName: readDeclaredName(targetDir),
	declaredKid,
	keyNames,
	revokedNames,
	...directory,
	...server,
	authWarning,
	env,
	targetDir,
	cwd: process.cwd(),
	settingsFindings,
	mcpJsonFacts: readMcpJsonFacts(targetDir),
	...pinFacts,
	...skins,
	...fleet,
	...refs
});
const report = renderAudit(flags.hosts === true ? groups.filter(([name]) => name === "hosts") : groups);
console.log(report);
process.exit(/\[WARN\]|\[\?\?\?\?\]/.test(report) ? 1 : 0);

//#endregion
export {  };