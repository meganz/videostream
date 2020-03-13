#!/usr/bin/env node

// Required dependencies
const util = require('util');
const babel = require("@babel/core");
const inherits = require('inherits');
const pkg = require('../package.json');
const UglifyJS = require("uglify-js");
const Browserify = require('browserify');
const Transform = require('stream').Transform || require('readable-stream').Transform;

// Helper constants
const startTime = Date.now();
const cwd = String(process.cwd()).replace(/\\/g, '/');
const babelOptions = {
    presets: [["@babel/preset-env", {loose: true, "targets": {"ie": "11"}}]]
};
let files = 0, sizes = 0, error = 0;

// Starts bundle creation
function makeBundle() {
    const b = new Browserify('./bundle/main.js');

    // Apply our transform.
    b.transform({global: true}, Megaify);

    // Build the bundle.
    b.bundle(function(err, buf) {
        if (err) {
            process.stderr.write(err.message + '\n');
            process.exit(1);
        }
        else {
            const user = process.env.username;
            const date = new Date().toISOString().replace(/-/g, '/').replace('T', ' ').split('.')[0];
            const header =
                '/**\n' +
                ' * This file is automatically generated. Do not edit it.\n' +
                ' * $Id: videostream.js,v ' + pkg.version + ' ' + date + ' ' + user + ' Exp $\n' +
                ' */\n';

            buf = buf.toString('utf-8');

            // Perform final transforms over the final bundle
            buf = buf.replace(new RegExp(cwd.replace(/\W/g, '\\$&'), 'g'), '');

            buf = header + buf;
            process.stdout.write(buf);

            process.stderr.write(
                '\n' +
                'Bundle created with size ' + buf.length + ' bytes,' +
                ' from ' + files + ' files with a sum of ' + sizes + ' bytes.\n' +
                'Process took: ' + (Date.now() - startTime) + 'ms\n'
            );

            process.exit(error);
        }
    });
}

// Our transform, thanks http://codewinds.com/blog/2013-08-20-nodejs-transform-streams.html
function Megaify(filename) {
    if (!(this instanceof Megaify)) {
        return new Megaify(filename);
    }
    Transform.call(this);

    this.cwd = cwd;
    this.osfile = filename;
    this.filesize = require('fs').statSync(filename).size;
    this.filename = String(filename).replace(/\\/g, '/').replace(this.cwd, '..');

    process.stderr.write('Bundling "' + this.filename + '" (' + this.filesize + ' bytes)\n');

    files++;
    sizes += this.filesize;

    this.readLength = 0;
    this.chunks = [];
}

inherits(Megaify, Transform);

Megaify.prototype._transform = function(chunk, enc, cb) {
    const self = this;
    const q = s => String(s).replace(/\W/g, '\\$&');
    const dump = s => process.stderr.write(s + '\n');
    const buffer = 'var Buffer = require("buffer").Buffer;\n';
    let beautify = true;
    let transpile = false;

    chunk = chunk.toString('utf-8');

    if (chunk.length < this.filesize) {
        this.readLength += chunk.length;
        this.chunks.push(chunk);

        process.stderr.write('Transform(' + this.filename + ') ' + this.readLength + '/' + this.filesize + '\n');

        if (this.readLength < this.filesize) {
            return cb();
        }
        chunk = this.chunks.join('');
    }

    // We'll loose transpile readable-stream +3.x's errors.js ourselves to save a few KBs...
    if (this.filename.indexOf('/readable-stream/errors-browser.js') > 0) {
        chunk = require('fs').readFileSync(this.osfile.replace('errors-browser.js', 'errors.js'));
        transpile = true;
    }

    // Transpile ECMAScript 2015+ code into a backwards compatible version
    if (transpile || this.filename.indexOf('/range-slice-stream/index.js') > 0) {
        chunk = babel.transformSync(chunk, babelOptions).code;

        chunk = chunk.replace(/function _inheritsLoose[^\n]+/, '');
        chunk = chunk.replace(/_inheritsLoose/g, "require('inherits')");
    }

    // Export mp4-box-encoding's boxes so we can extend them externally
    if (this.filename.indexOf('/mp4-box-encoding/index.js') > 0) {
        chunk = chunk.replace('Box = exports', 'Box=exports;Box.boxes=boxes');

        // Provide a more meaningful message for unsupported videos
        chunk = chunk.replace("throw new Error('Data too short')",
            "return new Error('Unsupported media format, data too short...')");

        // let's do some debugging here...
        chunk = chunk.replace('var obj = {}',
            'var obj=Object.create(null);if(d>1)console.warn("Box.decode", type, obj);');
        chunk = chunk.replace('var flags',
            '$&;if(d>1)console.warn("Box.readHeaders", [buffer], start, end,' +
            ' type, containers[type], boxes[type], boxes.fullBoxes[type]);' +
            'if (type === "sidx") ptr -= 8;'); // prevent exception parsing segment index

        // Allow the mp4 decoders to receive the headers
        chunk = chunk.replace('obj = decode(', 'obj = decode.call(headers,');
    }

    // Prevent the closures from implicit Buffer usages
    if (this.filename.indexOf('/ebml/tools.js') > 0
        || this.filename.indexOf('/ebml/decoder.js') > 0
        || this.filename.indexOf('/mp4-box-encoding/') > 0
        || this.filename.indexOf('/uint64be/index.js') > 0
        || this.filename.indexOf('/mp4-stream/decode') > 0) {

        chunk = buffer + chunk;
    }

    // Replace the slow .slice(arguments) usage
    if (this.filename.indexOf('/pump/index.js') > 0) {
        chunk = chunk.replace('var streams = Array.prototype.slice.call(arguments)',
            'var i = arguments.length;' +
            'var streams = new Array(i);' +
            'while(i--) streams[i] = arguments[i];');

        // we don't need fs nor process
        chunk = chunk.replace("var fs = require('fs')", '');
        chunk = chunk.replace('var isFS = function', 'if(0)$&');
        chunk = chunk.replace('isFS(stream)', '0');
        chunk = chunk.replace('var ancient =', '//$&');
    }

    // Remove specific nodejs stuff unused in the browser
    if (this.filename.indexOf('/end-of-stream/index.js') > 0) {
        chunk = chunk.replace('isRequest(stream)', '0');
        chunk = chunk.replace('isChildProcess(stream)', '0');
        chunk = chunk.replace('var isRequest = ', 'if(0)x=');
        chunk = chunk.replace('var isChildProcess = ', 'if(0)x=');
        chunk = chunk.replace('process.nextTick(onclosenexttick)', 'onIdle(onclosenexttick)');
    }

    // Remove 'global' references
    if (this.filename.indexOf('/base-audio-context/index.js') > 0
        || this.filename.indexOf('/promise-decode-audio-data/index.js') > 0) {

        chunk = chunk.replace(/\bglobal\./g, 'window.');

        if (this.filename.indexOf('/promise-decode-audio-data/index.js') > 0) {
            // Apply some compatibility tweaks
            chunk = chunk.replace(', reject);', ', reject.bind(null, Error("Legacy WebAudio API decoding error")));');
            chunk = chunk.replace('promise.then(', '//');
        }
    }

    // Let's apply some micro optimizations...
    if (this.filename.indexOf('/buffer/index.js') > 0) {
        chunk = chunk.replace(/assertSize\(size\)/g, '');
        chunk = chunk.replace(/ checked\(([^)]+)\) \| 0/g, ' $1 | 0');
        chunk = chunk.replace(/!noAssert/g, '0'); /* <- !!! */
        chunk = chunk.replace(/function (?:checked|assertSize|checkOffset|checkInt|checkIEEE754)/g, 'if(0)var _=$&');
    }

    // readable-stream includes core-util-is, but it's unused in the browser, dead code elimination
    // won't remove it because the inherits module is then defined extending core-util-is...
    if (this.filename.indexOf('readable-stream') > 0) {
        chunk = chunk.replace("var util = require('core-util-is');", '');
        chunk = chunk.replace('util.inherits =', 'var inherits =');
        chunk = chunk.replace('util.inherits(', 'inherits(');
        // ^ yes, it's used/invoked once per file only

        // Replace the isarray module, we don't need a fallback for older browsers
        chunk = chunk.replace("require('isarray')", 'Array.isArray');

        // We don't need any process.* stuff...
        let re = new RegExp(q("require('process-nextick-args')"), 'g');
        chunk = chunk.replace(re, self.getUtilsMod(1));
        chunk = chunk.replace(' && dest !== process.stdout && dest !== process.stderr', '');
        chunk = chunk.replace('process.emitWarning', 'console.warn');

        // Replace process.nextTick calls not covered by the above
        re = q('process.nextTick(') + '([^,]+?)(,[^)]+?)?\\)';
        chunk = chunk.replace(new RegExp(re, 'g'), 'onIdleA($1.bind(null$2))');

        // We don't need util.inspect...
        if (this.filename.indexOf('/readable-stream/lib/internal/streams/buffer_list.js') > 0) {
            chunk = "'use strict';\n" + buffer + chunk.substr(chunk.indexOf('function copyBuffer'));
            chunk = chunk.replace("_proto[custom]", 'if(0)var _');
            chunk = chunk.replace('_classCallCheck', '0&&$&');
        }

        // readable-stream +3.x added Symbol.asyncIterator which we don't need...
        if (this.filename.indexOf('/readable-stream/lib/_stream_readable.js') > 0) {
            chunk = chunk.replace("var _require2 = require('../experimentalWarning'),", '');
            chunk = chunk.replace("emitExperimentalWarning = _require2.emitExperimentalWarning;", '');
            chunk = chunk.replace('Readable.prototype[Symbol.asyncIterator]', 'if(0)var _');
            chunk = chunk.replace('Readable.from =', 'if(0)_=');
            chunk = chunk.replace("require('./internal/streams/async_iterator')", '0xBADF');
        }

        // readable-stream 3.4.0 did borrow some code from end-fo-stream
        if (this.filename.indexOf('/end-of-stream.js') > 0
            || this.filename.indexOf('/pipeline.js') > 0) {

            chunk = chunk.replace('function isRequest', 'if(0)x=function');
            chunk = chunk.replace('isRequest(stream)', '0');
            chunk = chunk.replace('function once', 'var once=require("once");if(0)x=$&');
            // ^ the only difference is that their once function won't return the cached value, any issue?
        }

        // readable-stream +3.x removed OurUint8Array out of an /*<replacement>*/ block..
        re = '([\n\\s]+var Buffer[^\n]+[\n\\s]+var OurUint8Array[\\s\\S]+?function _isUint8Array[^}]+\\})';
        chunk = chunk.replace(new RegExp(re), '\n\n/*<replacement>*/$1\n/*</replacement>*/\n');

        // Transpile /*<replacement>*/ blocks to our needs...
        chunk = this.getReplacements(chunk, function(match) {

            // Let's use our MegaLogger
            if (match.indexOf('debugUtil') > 0) {
                return 'var debug = ' + self.getUtilsMod(1) + '.debuglog("stream")';
            }

            // Let's use our nextTick based on requestIdleCallback
            if (match.indexOf('var asyncWrite =') > 0) {
                return 'var asyncWrite = ' + self.getUtilsMod(1) + '.nextTick';
            }

            // Let's use our tiny deprecate shim
            if (match.indexOf('internalUtil') > 0) {
                return 'var deprecate = ' + self.getUtilsMod(1) + '.deprecate';
            }

            // OurUint8Array is just Uint8Array in the browser
            if (match.indexOf('OurUint8Array') > 0) {
                return 'var _isUint8Array=' + self.getUtilsMod(1) + '.isU8,Buffer=require("buffer").Buffer';
            }

            // No Object.keys polyfill needed
            if (match.indexOf('var objectKeys = ') > 0) {
                return 'var objectKeys = Object.keys;';
            }

            return match;
        });

        // Remove util-deprecate dependency
        chunk = chunk.replace('internalUtil.deprecate(', 'deprecate(');

        // Replace redundant _uint8ArrayToBuffer
        chunk = chunk.replace('_uint8ArrayToBuffer', 'Buffer.from');
    }

    // Revert mp4-box-encoding 1.1.3 & mp4-stream 2.0.3 useless buffer-alloc/from dependency addition
    if (this.filename.indexOf('mp4-stream') > 0
        || this.filename.indexOf('uint64be/index.j') > 0 // 2.0.2
        || this.filename.indexOf('mp4-box-encoding') > 0) {

        chunk = chunk.replace(/var \w+ = require\('buffer-(?:alloc|from)'\)/g, '');
        chunk = chunk.replace(/\bbufferAlloc\b/g, 'Buffer.allocUnsafe');
        chunk = chunk.replace(/\bbufferFrom\b/g, 'Buffer.from');

        // mp4-box-encoding 1.4.1 removed buffer-alloc|from dependency - we can still use the unsafe call
        if (this.filename.indexOf('mp4-box-encoding') > 0) {
            chunk = chunk.replace(/\bBuffer.alloc\(/g, 'Buffer.allocUnsafe(');
        }
    }

    // Replace references to process.* and explicitly include Buffer to prevent a closure
    if (this.filename.indexOf('mp4-stream/encode.js') > 0) {
        chunk = chunk.replace('return process.nextTick', 'return nextTick');
        chunk = chunk.replace('function noop () {}',
            'var nextTick=' + self.getUtilsMod(1) + '.nextTick, Buffer = require("buffer").Buffer;\n$&');
    }

    // Invoke self._createSourceBuffer() failures asynchronously.
    if (this.filename.indexOf('/mediasource/index.js') > 0) {
        chunk = chunk.replace("self.destroy(new Error('The provided type is not supported'))",
            "onIdle(self.destroy.bind(self, new Error('The provided type is not supported')))");
    }

    // Fix off-by-one bug in uint64be v1.0.1
    if (this.filename.indexOf('/uint64be/index.js') > 0) {
        chunk = chunk.replace('UINT_32_MAX = 0xffffffff', 'UINT_32_MAX = Math.pow(2, 32)');
    }

    // Make the ebml schema smaller (saving ~40KB)
    if (this.filename.indexOf('/ebml/schema.js') > 0) {
        chunk = chunk.replace(/^\s+"(?:description|cppname)":\s*".*",?$/mg, '');
        beautify = false;
    }

    // safe-buffer seems redundant for the browser...
    chunk = chunk.replace("require('safe-buffer').Buffer", "require('buffer').Buffer");

    // No fallback needed for Object.create
    chunk = chunk.replace("require('inherits')", self.getUtilsMod(1) + '.inherit');
    chunk = chunk.replace("require('util').inherits", self.getUtilsMod(1) + '.inherit');

    // Let's always use readable-stream
    chunk = chunk.replace(/require\(["']stream["']\)/g, 'require("readable-stream")');

    // BEGIN EventEmitter3 Tweaks
    chunk = chunk.replace(/require\(["']events["']\)/g, 'require("eventemitter3")');

    // Extend EventEmitter3 to support prependListener
    if (this.filename.indexOf('/eventemitter3/index.js') > 0) {
        chunk = chunk.replace('EventEmitter.prototype.on = function on(event, fn, context', '$&, pp');
        chunk = chunk.replace('return addListener(this, event, fn, context, false', '$&, pp');
        chunk = chunk.replace('function addListener(emitter, event, fn, context, once', '$&, pp');
        chunk = chunk.replace('[evt].push(listener)', '[evt][pp?"unshift":"push"](listener)');
        chunk = chunk.replace('[emitter._events[evt], listener]', 'pp ? [listener,emitter._events[evt]] : $&');
    }

    // Replace prependListener usage.
    if (this.filename.indexOf('/readable-stream/lib/_stream_readable.js') > 0) {
        chunk = chunk.replace("prependListener(dest, 'error', onerror)", "dest.on('error', onerror, 0, true)");
    }
    // END EventEmitter3 Tweaks

    // Remove debug calls
    chunk = chunk.replace("require('debug')", '');
    chunk = chunk.replace(/^\s*debug\(.*\);/gm, '');

    // Let's remove dead code and such...
    const uglify = UglifyJS.minify(chunk, {
        warnings: true,
        mangle: false,
        compress: {
            passes: 3,
            loops: false,
            sequences: false,
            comparisons: false,
            pure_getters: true,
            keep_infinity: true
        },
        output: {
            indent_level: 2,
            ascii_only: true,
            comments: 'some',
            beautify: beautify
        }
    });

    if (uglify) {
        if (uglify.error) {
            error++;
            process.stderr.write('UglifyJS error: ' + util.inspect(uglify) + '\n');
        }
        else {
            chunk = uglify.code;

            if (uglify.warnings) {
                const tag = 'UglifyJS(' + this.filename + '): ';
                process.stderr.write(tag + uglify.warnings.join("\n" + tag) + '\n');
            }
        }
    }

    this.push(chunk);
    cb();
};

Megaify.prototype.getReplacements = function(chunk, filter) {
    return chunk.replace(/\/\*<replacement>\*\/[\s\S]*?\/\*<\/replacement>\*\//g, filter);
};

Megaify.prototype.getUtilsMod = function(asreq) {
    const module = this.cwd + '/bundle/utils';

    return asreq ? 'require("' + module + '")' : module;
};

makeBundle();
