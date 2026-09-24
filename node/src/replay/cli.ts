import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { NativeClient } from '../native/client.js';
import { AgentApi } from '../agent/api.js';
import { ProfileEngine } from '../profiles/engine.js';
import { NodeVision } from '../vision/service.js';
import { createPrivateCall } from '../agent/router.js';
import { loadRecipe } from './recipe.js';
import { runReplay } from './runner.js';
import { assetBytes, exportArchive, openArchive } from './archive.js';
import { draftFromRecording } from './draft.js';
import { inspectRun } from './recovery.js';

const [command, input, output] = process.argv.slice(2);
if (!['validate','play','resume','inspect','export','draft'].includes(command) || !input ||
  (['play','resume','inspect','export','draft'].includes(command) && !output)) {
  process.stderr.write('Usage: replay validate <recipe-dir|file.dpreplay> | replay export <recipe-dir> <new-file.dpreplay> | replay play <recipe-dir|file.dpreplay> <new-run-dir> | replay inspect|resume <recipe-dir|file.dpreplay> <run-dir> | replay draft <recording.jsonl> <new-recipe-dir>\n');
  process.exitCode = 2;
} else {
  let native: NativeClient | undefined;
  let cleanup: (()=>Promise<void>) | undefined;
  try {
    if (command === 'draft') {
      const count=await draftFromRecording(resolve(input),resolve(output!));
      process.stdout.write(`Drafted ${count} semantic steps for review: ${resolve(output!)}\n`);
    } else if (command === 'export') {
      await exportArchive(resolve(input),resolve(output!));
      process.stdout.write(`Exported: ${resolve(output!)}\n`);
    } else {
    const source=input.toLowerCase().endsWith('.dpreplay') ? await openArchive(resolve(input)) : undefined;
    cleanup=source?.cleanup;
    const recipeDirectory=source?.directory ?? resolve(input);
    const recipe = await loadRecipe(recipeDirectory);
    await assetBytes(recipeDirectory,recipe);
    if (command === 'validate') process.stdout.write(`Valid recipe: ${recipe.name} (${recipe.steps.length} steps)\n`);
    else if (command === 'inspect') process.stdout.write(JSON.stringify(await inspectRun(resolve(output!),recipe))+'\n');
    else {
      const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
      const executable = process.env.DP_NATIVE_EXE ?? [
        resolve(packageRoot, 'native/desktop-pilot-native.exe'),
        resolve(packageRoot, 'build/release/Release/desktop-pilot-native.exe')
      ].find(existsSync) ?? resolve(packageRoot, 'native/desktop-pilot-native.exe');
      native = new NativeClient(executable);
      const hello = await native.start();
      if (hello.preflight.ready !== true) throw new Error(`Desktop unavailable: ${JSON.stringify(hello.preflight)}`);
      const call = createPrivateCall(native, new NodeVision());
      const profiles = new ProfileEngine((operation,args,options) => call(operation,args,options),
        process.env.DP_PROFILES_DIR ?? resolve(packageRoot,'profiles'));
      const summary=await runReplay(new AgentApi(native,profiles),recipe,resolve(output!),recipeDirectory,
        command==='resume');
      process.stdout.write(`Replay finished (${summary.verification}): ${resolve(output!)}\n`);
    }
    }
  } catch (error) {
    process.stderr.write(`Replay stopped: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally { native?.close();await cleanup?.(); }
}
