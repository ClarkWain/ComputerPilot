import { mkdir, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const session = `${process.env.USERNAME ?? process.env.USER ?? 'user'}:${process.env.SESSIONNAME ?? 'default'}`;
const name = createHash('sha256').update(session).digest('hex').slice(0, 20);
export const desktopLockPath = join(tmpdir(), `desktop-pilot-input-${name}.lock`);

export async function acquireDesktopLock(lockPath=desktopLockPath): Promise<() => Promise<void>> {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx');
      try { await file.writeFile(JSON.stringify({ pid: process.pid, token }));await file.sync(); }
      finally { await file.close(); }
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
          if (current.token === token) await unlink(lockPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner: { pid?: number; token?: string };
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) as typeof owner; }
      catch { throw new Error(`Desktop input lock is busy or damaged: ${lockPath}`); }
      if (!Number.isInteger(owner.pid) || !owner.token) throw new Error(`Desktop input lock is damaged: ${lockPath}`);
      try { process.kill(owner.pid!, 0); throw new Error(`Desktop input is in use by process ${owner.pid}`); }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check;
        const guard=lockPath+'.recovery';
        try { await mkdir(guard); }
        catch { throw new Error(`Desktop input lock recovery is in progress: ${guard}`); }
        try {
          const current=JSON.parse(await readFile(lockPath,'utf8')) as {pid?:number;token?:string};
          if (current.token !== owner.token) throw new Error('Desktop input lock changed during recovery');
          await unlink(lockPath);
        } finally { await rmdir(guard); }
      }
    }
  }
  throw new Error(`Unable to acquire desktop input lock: ${lockPath}`);
}
