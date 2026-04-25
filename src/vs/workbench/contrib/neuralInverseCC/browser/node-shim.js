// No-op shim for all Node.js built-ins used by the neuralInverseCC tree.
// The VS Code renderer sandbox has no access to Node built-ins at runtime.
// All exports are stubs — CC browser/ code that calls these gets safe no-ops.

const noop = function() {};
const noopAsync = async function() {};
const noopStr = () => '';
const noopArr = () => [];
const noopObj = () => ({});
const noopBool = () => false;
const noopNum = () => 0;

// fs
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
export const realpathSync = (p) => p;
export const readdirSync = noopArr;
export const mkdirSync = noop;
export const unlinkSync = noop;
export const rmSync = noop;
export const rm = noop;
export const chmodSync = noop;
export const accessSync = noop;
export const createReadStream = noopObj;
export const createWriteStream = noopObj;
export const watch = noopObj;
export const watchFile = noop;
export const unwatchFile = noop;
export const promises = { readFile: noopAsync, writeFile: noopAsync, appendFile: noopAsync, stat: noopAsync, readdir: noopAsync, mkdir: noopAsync, unlink: noopAsync, rm: noopAsync, access: noopAsync, realpath: async (p) => p };
export const constants = {};

// path
export const join = (...args) => args.filter(Boolean).join('/');
export const resolve = (...args) => args.filter(Boolean).join('/');
export const dirname = (p) => (p || '').split('/').slice(0, -1).join('/') || '/';
export const basename = (p, ext) => { const b = (p || '').split('/').pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export const extname = (p) => { const m = (p || '').match(/\.[^.]+$/); return m ? m[0] : ''; };
export const normalize = (p) => p || '';
export const isAbsolute = (p) => (p || '').startsWith('/');
export const relative = () => '';
export const sep = '/';
export const delimiter = ':';
export const posix = { join, resolve, dirname, basename, extname, normalize, isAbsolute, relative, sep: '/', delimiter: ':' };
export const win32 = posix;
export const parse = (p) => ({ root: '', dir: dirname(p), base: basename(p), ext: extname(p), name: basename(p, extname(p)) });
export const format = (o) => (o && o.dir ? o.dir + '/' : '') + (o && o.base || '');
export const fileURLToPath = (u) => typeof u === 'string' ? u.replace(/^file:\/\//, '') : u;
export const pathToFileURL = (p) => 'file://' + p;

// os
export const homedir = () => '/home/user';
export const tmpdir = () => '/tmp';
export const platform = () => 'linux';
export const release = noopStr;
export const hostname = noopStr;
export const userInfo = () => ({ username: '', homedir: '/home/user', shell: '', uid: -1, gid: -1 });
export const type = () => 'Linux';
export const version = noopStr;

// crypto
export const randomBytes = (n) => new Uint8Array(n);
export const randomUUID = () => '00000000-0000-0000-0000-000000000000';
export const createHash = () => ({ update() { return this; }, digest: noopStr });

// child_process
export const exec = noop;
export const execSync = noopStr;
export const execFile = noop;
export const execFileSync = noopStr;
export const spawn = () => ({ stdout: { on: noop, pipe: noop }, stderr: { on: noop, pipe: noop }, on: noop, kill: noop });
export const spawnSync = () => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') });

// util
export const promisify = (fn) => async (...args) => fn(...args);
export const inspect = (v) => String(v);
export const isDeepStrictEqual = (a, b) => a === b;

// url
export const URL = globalThis.URL || class URL { constructor(u) { this.href = u; } };

// stream / https / net / http
export const PassThrough = class { pipe(d) { return d; } on() { return this; } write() {} end() {} };
export const Stream = PassThrough;
export const Agent = class {};
export const createServer = () => ({ listen: noop, on: noop, close: noop });
export const createConnection = () => ({ on: noop, write: noop, end: noop });
export const isIP = () => 0;

// process (fallback if globalThis.process is missing)
export const cwd = () => '/';
export const env = {};

export default {};
