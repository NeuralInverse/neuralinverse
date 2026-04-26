// No-op shim for all Node.js built-ins used by the neuralInverseCC tree.
// The VS Code renderer sandbox has no access to Node built-ins at runtime.
// All exports are stubs — CC browser/ code that calls these gets safe no-ops.

// Patch globalThis.process immediately — CC module factories access process.stdin/stdout at init time.
(function() {
    if (typeof globalThis.process === 'undefined') { globalThis.process = {}; }
    const p = globalThis.process;
    if (!p.env) p.env = {};
    if (!p.stdout) p.stdout = { write: () => true, isTTY: false, columns: 80, rows: 24, on() { return this; }, once() { return this; }, removeListener() { return this; } };
    if (!p.stderr) p.stderr = { write: () => true, isTTY: false, on() { return this; }, once() { return this; }, removeListener() { return this; } };
    if (!p.stdin)  p.stdin  = { on() { return this; }, once() { return this; }, removeListener() { return this; }, resume() {}, pause() {}, isTTY: false, setRawMode() {} };
    if (!p.exit)     p.exit = () => {};
    if (!p.platform) p.platform = 'linux';
    if (!p.version)  p.version = 'v20.0.0';
    if (!p.versions) p.versions = {};
    if (!p.argv)     p.argv = [];
    if (!p.cwd)      p.cwd = () => '/';
    if (!p.nextTick) p.nextTick = (fn, ...a) => Promise.resolve().then(() => fn(...a));
    if (!p.uptime)   p.uptime = () => 0;
})();

const noop = function() {};
const noopAsync = async function() {};
const noopStr = () => '';
const noopArr = () => [];
const noopObj = () => ({});
const noopBool = () => false;
const noopNum = () => 0;

// ── fs ───────────────────────────────────────────────────────────────────────
export const readFileSync = noopStr;
export const writeFileSync = noop;
export const appendFileSync = noop;
export const fsyncSync = noop;
export const openSync = noopNum;
export const closeSync = noop;
export const readSync = noopNum;
export const writeSync = noopNum;
export const fstat = noop;
export const fstatSync = noopObj;
export const existsSync = noopBool;
export const statSync = noopObj;
export const realpathSync = (p) => p || '';
export const readdirSync = noopArr;
export const mkdirSync = noop;
export const unlinkSync = noop;
export const rmSync = noop;
export const rm = noop;
export const chmodSync = noop;
export const accessSync = noop;
export const createReadStream = noopObj;
export const createWriteStream = noopObj;
export const lstatSync = noopObj;
export const copyFileSync = noop;
export const renameSync = noop;
export const truncateSync = noop;
export const watch = () => ({ close: noop, on: noop });
export const watchFile = noop;
export const unwatchFile = noop;
export const promises = {
    readFile: noopAsync, writeFile: noopAsync, appendFile: noopAsync,
    stat: noopAsync, readdir: noopAsync, mkdir: noopAsync, unlink: noopAsync,
    rm: noopAsync, access: noopAsync, realpath: async (p) => p || '',
    open: noopAsync, close: noopAsync, chmod: noopAsync, symlink: noopAsync,
    rename: noopAsync, copyFile: noopAsync, lstat: noopAsync, readlink: noopAsync,
    rmdir: noopAsync,
};
// fs/promises named exports (imported as: import { readFile, stat, ... } from 'fs/promises')
export const readFile = noopAsync;
export const writeFile = noopAsync;
export const appendFile = noopAsync;
export const mkdir = noopAsync;
export const mkdtemp = noopAsync;
export const symlink = noopAsync;
export const link = noopAsync;
export const rename = noopAsync;
export const unlink = noopAsync;
export const rmdir = noopAsync;
export const stat = noopAsync;
export const lstat = noopAsync;
export const readdir = noopAsync;
export const realpath = async (p) => p || '';
export const open = noopAsync;
export const copyFile = noopAsync;
export const chmod = noopAsync;
export const readlink = noopAsync;
export const access = noopAsync;
export const truncate = noopAsync;
export const utimes = noopAsync;
export const constants = { O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
// type aliases (compiled TS imports these as values in some patterns)
export const FSWatcher = class { close() {} on() { return this; } };
export const Stats = class {};
export const WriteStream = class { write() {} end() {} on() { return this; } };

// ── path ─────────────────────────────────────────────────────────────────────
export const join = (...args) => args.filter(Boolean).join('/').replace(/\/+/g, '/');
export const resolve = (...args) => '/' + args.filter(Boolean).join('/').replace(/\/+/g, '/');
export const dirname = (p) => (p || '').split('/').slice(0, -1).join('/') || '/';
export const basename = (p, ext) => { const b = (p || '').split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export const extname = (p) => { const m = (p || '').match(/\.[^./]+$/); return m ? m[0] : ''; };
export const normalize = (p) => (p || '').replace(/\/+/g, '/');
export const isAbsolute = (p) => (p || '').startsWith('/');
export const relative = () => '';
export const sep = '/';
export const delimiter = ':';
export const posix = { join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, sep: '/', delimiter: ':' };
export const win32 = posix;
export const parse = (p) => ({ root: '', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) });
export const formatPath = (o) => (o && o.dir ? o.dir + '/' : '') + (o && o.base || '');

// ── url ──────────────────────────────────────────────────────────────────────
export const URL = globalThis.URL || class URL { constructor(u) { this.href = u; } };
export const fileURLToPath = (u) => typeof u === 'string' ? u.replace(/^file:\/\//, '') : String(u);
export const pathToFileURL = (p) => ({ href: 'file://' + (p || ''), toString() { return this.href; } });

// ── os ───────────────────────────────────────────────────────────────────────
export const homedir = () => '/home/user';
export const tmpdir = () => '/tmp';
export const platform = () => 'linux';
export const release = noopStr;
export const hostname = noopStr;
export const userInfo = () => ({ username: '', homedir: '/home/user', shell: '/bin/sh', uid: -1, gid: -1 });
export const type = () => 'Linux';
export const version = noopStr;

// ── crypto ───────────────────────────────────────────────────────────────────
export const randomBytes = (n) => new Uint8Array(n);
export const randomUUID = () => '00000000-0000-0000-0000-000000000000';
export const UUID = randomUUID;
export const createHash = () => ({ update() { return this; }, digest: noopStr });

// ── child_process ────────────────────────────────────────────────────────────
const mockProc = () => ({ stdout: { on: noop, pipe: noop, setEncoding: noop }, stderr: { on: noop, pipe: noop, setEncoding: noop }, stdin: { write: noop, end: noop }, on: noop, once: noop, kill: noop, pid: -1 });
export const exec = (cmd, opts, cb) => { if (typeof opts === 'function') opts(null, '', ''); else if (typeof cb === 'function') cb(null, '', ''); return mockProc(); };
export const execSync = noopStr;
export const execFile = (f, a, o, cb) => { const fn = typeof o === 'function' ? o : cb; if (typeof fn === 'function') fn(null, '', ''); return mockProc(); };
export const execFileSync = noopStr;
export const spawn = () => mockProc();
export const spawnSync = () => ({ status: 0, stdout: new Uint8Array(0), stderr: new Uint8Array(0), output: [], pid: -1, signal: null, error: null });
export const ChildProcess = class { on() { return this; } kill() {} };
export const ChildProcessWithoutNullStreams = ChildProcess;

// ── events ───────────────────────────────────────────────────────────────────
export const EventEmitter = class {
    on() { return this; } off() { return this; } emit() { return false; }
    once() { return this; } removeListener() { return this; }
    addListener() { return this; } removeAllListeners() { return this; }
    listeners() { return []; } listenerCount() { return 0; }
};
export const setMaxListeners = noop;
export const getMaxListeners = noopNum;

// ── buffer ───────────────────────────────────────────────────────────────────
export const Buffer = globalThis.Buffer || class Buffer extends Uint8Array {
    static from(v, enc) { if (typeof v === 'string') return new Uint8Array(new TextEncoder().encode(v)); return new Uint8Array(v); }
    static alloc(n, fill) { const b = new Uint8Array(n); if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
    static isBuffer(v) { return v instanceof Uint8Array; }
    static concat(bufs, len) { const t = len || bufs.reduce((a, b) => a + b.length, 0); const r = new Uint8Array(t); let o = 0; for (const b of bufs) { r.set(b, o); o += b.length; } return r; }
    toString(enc) { return new TextDecoder().decode(this); }
};

// ── stream ───────────────────────────────────────────────────────────────────
export const PassThrough = class {
    pipe(d) { return d; } on() { return this; } once() { return this; }
    write() { return true; } end() {} push() {} resume() {} pause() {}
};
export const Stream = PassThrough;
export const Readable = PassThrough;
export const Writable = PassThrough;
export const Transform = PassThrough;

// ── zlib ─────────────────────────────────────────────────────────────────────
export const deflateSync = () => new Uint8Array(0);
export const inflateSync = () => new Uint8Array(0);
export const gzipSync = () => new Uint8Array(0);
export const gunzipSync = () => new Uint8Array(0);
export const createGzip = () => new PassThrough();
export const createGunzip = () => new PassThrough();
export const createDeflate = () => new PassThrough();
export const createInflate = () => new PassThrough();

// ── http / https / net ───────────────────────────────────────────────────────
export const Server = class { listen() { return this; } on() { return this; } close(cb) { if (cb) cb(); } };
export const Socket = class { on() { return this; } write() {} end() {} destroy() {} };
export const Agent = class {};
export const createServer = () => new Server();
export const createConnection = () => new Socket();
export const request = (opts, cb) => { if (cb) cb({ on: noop, statusCode: 200 }); return { on: noop, write: noop, end: noop }; };
export const isIP = () => 0;

// ── readline ─────────────────────────────────────────────────────────────────
export const createInterface = () => ({ on: noop, once: noop, close: noop, question: (q, cb) => cb && cb(''), [Symbol.asyncIterator]: async function*() {} });
export const ReadStream = class { on() { return this; } };

// ── tty ──────────────────────────────────────────────────────────────────────
// ReadStream already exported above

// ── util ─────────────────────────────────────────────────────────────────────
export const promisify = (fn) => (...args) => new Promise((res, rej) => fn(...args, (err, val) => err ? rej(err) : res(val)));
export const inspect = (v) => String(v);
export const isDeepStrictEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const format = (...args) => args.map(String).join(' ');
export const deprecate = (fn) => fn;
export const inherits = noop;

// ── process ──────────────────────────────────────────────────────────────────
export const cwd = () => '/';
export const env = {};
export const exit = noop;
export const nextTick = (fn, ...args) => Promise.resolve().then(() => fn(...args));

export default {};
