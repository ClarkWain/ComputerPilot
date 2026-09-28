export type SunoSong = { title: string; lyrics: string; style: string };

export function validateSunoSong(value: unknown): SunoSong {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Song input must be a JSON object');
  const input = value as Record<string,unknown>;
  if (Object.keys(input).some(key => !['title','lyrics','style'].includes(key)))
    throw new Error('Song input accepts only title, lyrics and style');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const lyrics = typeof input.lyrics === 'string' ? input.lyrics.trim() : '';
  const style = typeof input.style === 'string' ? input.style.trim() : '';
  if (!title || !lyrics || !style) throw new Error('title, lyrics and style must be nonempty text');
  if (title.length > 200 || lyrics.length > 20_000 || style.length > 2_000)
    throw new Error('Song input exceeds local limits (title 200, lyrics 20000, style 2000 characters)');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(title+lyrics+style))
    throw new Error('Song input contains unsupported control characters');
  return {title,lyrics,style};
}
