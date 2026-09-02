// What an Instagram link is pointing at.
//
// The whole feature hangs on this: a post offers its media, a bare username
// offers stories, and everything else has to say so rather than being handed
// to yt-dlp to fail confusingly.
import { classifyInstagram } from '../lib/tools/downloader.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} ${detail}`);
  cond ? pass++ : fail++;
};

const kind = (u) => {
  const r = classifyInstagram(u);
  return r ? r.kind : null;
};

console.log('--- posts ---');
check('a post', kind('https://www.instagram.com/p/C8xYzAbC1de/') === 'post');
check('a reel', kind('https://www.instagram.com/reel/C8xYzAbC1de/') === 'post');
check('igtv', kind('https://www.instagram.com/tv/C8xYzAbC1de/') === 'post');
check('the code is carried through',
  classifyInstagram('https://www.instagram.com/p/C8xYzAbC1de/').code === 'C8xYzAbC1de');
// A real share link carries far more than the shortcode after /p/, and the
// whole segment fed to the base64 decoder is a 400 from Instagram.
const long = classifyInstagram('https://www.instagram.com/p/DXvTML7DxBp3pcHH461HJmYQ5coZdRh34Os6ww0/');
check('a long share link is trimmed to the 11-char shortcode',
  long && long.code === 'DXvTML7DxBp', long && long.code);
check('...and still reads as a post', long && long.kind === 'post');

check('query strings and trailing slashes do not matter',
  kind('https://instagram.com/p/C8xYzAbC1de?igshid=abc') === 'post');

console.log('\n--- accounts ---');
const profile = classifyInstagram('https://www.instagram.com/nasa/');
check('a bare username is a profile', profile && profile.kind === 'profile', profile && profile.user);
check('...and is rewritten to the stories address',
  profile && profile.storiesUrl === 'https://www.instagram.com/stories/nasa/',
  profile && profile.storiesUrl);
check('no www needed', kind('https://instagram.com/nasa') === 'profile');

console.log('\n--- stories ---');
const story = classifyInstagram('https://www.instagram.com/stories/nasa/3412345678901234567/');
check('a single story', story && story.kind === 'story', story && story.user);

console.log('\n--- things that are not fetchable ---');
for (const [path, why] of [
  ['/explore/tags/cats/', 'explore'],
  ['/accounts/login/', 'the login page'],
  ['/direct/inbox/', 'DMs'],
  ['/p/', 'a post with no code'],
  ['/stories/', 'stories with no account'],
]) {
  check(`${why} is refused`, kind(`https://www.instagram.com${path}`) === 'unsupported', path);
}
check('the bare domain is not a profile', kind('https://www.instagram.com/') === 'home');

console.log('\n--- other sites are none of its business ---');
check('youtube is not classified', classifyInstagram('https://youtube.com/watch?v=abc') === null);
check('a lookalike domain is not matched',
  classifyInstagram('https://instagram.com.evil.example/p/abc') === null);
check('a subdomain still counts', kind('https://www.instagram.com/p/abc') === 'post');
check('nonsense is not a URL', classifyInstagram('not a url') === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
