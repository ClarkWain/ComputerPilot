type Context = {
  readInput<T>(id: string): Promise<T>;
  suno(id: string, args: unknown): Promise<unknown>;
  ask(id: string, args: {question:string;choices:string[]}): Promise<string>;
  checkpoint(id: string, value: unknown): Promise<void>;
};
type Song = {title:string;lyrics:string;style:string};
type Snapshot = {state:string;trackUrls:string[];blocker?:string};
type Submission = {status:string;trackUrls:string[]};
type Wait = {status:string;trackUrls:string[]};

/** Entry script has no local imports so its frozen SHA covers the whole authored workflow. */
export default async function run(ctx: Context): Promise<unknown> {
  const frozen = await ctx.readInput<Song>('song');
  const song:Song = {title:frozen.title,lyrics:frozen.lyrics,style:frozen.style};
  let page = await ctx.suno('inspect', {op:'inspect'}) as Snapshot;
  if (page.state === 'login_required') {
    const answer = await ctx.ask('login', {
      question:'Suno requires a one-time login in the dedicated browser profile. Continue after login?',
      choices:['ready','cancel']
    });
    if (answer === 'cancel') return {status:'login_required'};
    page = await ctx.suno('inspect_after_login', {op:'inspect'}) as Snapshot;
  }
  if (page.state !== 'form_ready') throw new Error(`Suno Create form is unavailable: ${page.blocker ?? page.state}`);
  const prepared = await ctx.suno('prepare', {op:'prepare',song}) as {status:string};
  if (prepared.status !== 'prepared') throw new Error('Suno form was not verified after filling');
  await ctx.checkpoint('prepared',{title:song.title});
  const submission = await ctx.suno('submit', {op:'submit',song,baselineUrls:page.trackUrls}) as Submission;
  if (submission.status !== 'submitted' || !submission.trackUrls?.length)
    throw new Error('Suno submission did not return new song links');
  await ctx.checkpoint('submitted',{title:song.title,trackUrls:submission.trackUrls});
  for (let attempt=1;attempt<=6;attempt++) {
    const result = await ctx.suno(`wait_${attempt}`,{
      op:'wait',trackUrls:submission.trackUrls,timeoutMs:60_000
    }) as Wait;
    if (result.status === 'ready')
      return {status:'ready',title:song.title,trackUrls:result.trackUrls};
    if (result.status !== 'pending') throw new Error(`Unexpected Suno generation state: ${result.status}`);
  }
  return {status:'submitted_pending',title:song.title,trackUrls:submission.trackUrls};
}
