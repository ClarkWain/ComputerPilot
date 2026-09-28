import { acquireRunLock } from '../workflow/journal.js';
import { ensureDirectoryNoLinks } from '../workflow/paths.js';
import type { CommandRequest, OrchestrationHost } from '../orchestration/types.js';
import { SunoBrowser, sunoProfileDirectory } from './browser.js';
import { validateSunoSong } from './input.js';

export function createSunoHost(profileDirectory = sunoProfileDirectory(), browser = new SunoBrowser(profileDirectory)):
  OrchestrationHost {
  let release: (()=>Promise<void>) | undefined;
  const ensureLease = async () => {
    if (release) return;
    await ensureDirectoryNoLinks(profileDirectory);
    release=await acquireRunLock(profileDirectory);
  };
  return {
    async releaseDesktop() {
      const held=release; release=undefined; await held?.();
    },
    async execute(request:CommandRequest) {
      if (request.kind!=='suno' || !request.args || typeof request.args!=='object')
        throw new Error('Suno host accepts only Suno commands');
      await ensureLease();
      const args=request.args as Record<string,unknown>;
      if (args.op==='inspect') return browser.inspect();
      if (args.op==='prepare') return browser.prepare(validateSunoSong(args.song));
      if (args.op==='submit') {
        const song=validateSunoSong(args.song);
        if (!Array.isArray(args.baselineUrls) || args.baselineUrls.some(x=>typeof x!=='string'))
          throw new Error('Suno submit requires baseline song URLs');
        return browser.submit(song,args.baselineUrls as string[]);
      }
      if (args.op==='wait') {
        if (!Array.isArray(args.trackUrls) || args.trackUrls.some(x=>typeof x!=='string') ||
            !Number.isInteger(args.timeoutMs)) throw new Error('Suno wait arguments are invalid');
        return browser.wait(args.trackUrls as string[],Number(args.timeoutMs));
      }
      throw new Error(`Unknown Suno operation: ${String(args.op)}`);
    }
  };
}
