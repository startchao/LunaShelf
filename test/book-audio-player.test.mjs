import test from 'node:test';
import assert from 'node:assert/strict';
import { BookAudioPlayer, audioTime } from '../src/book-audio-player.js';
class FakeAudio {
  constructor() { this.events = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.duration = NaN; this.playbackRate = 1; }
  addEventListener(name, cb) { (this.events[name] ||= []).push(cb); }
  emit(name) { for (const cb of this.events[name] || []) cb(); }
  play() { this.paused = false; this.emit('playing'); return Promise.resolve(); }
  pause() { const wasPaused = this.paused; this.paused = true; if (!wasPaused) this.emit('pause'); }
  removeAttribute() { this.src = ''; }
  load() {}
}
function setup() {
  const audio = new FakeAudio(), data = new Map(), actions = {}, revoked = [];
  let expired = false, prepared = 0;
  const session = { setActionHandler:(name, cb)=>{actions[name]=cb;}, setPositionState: value=>{session.position=value;} };
  const player = new BookAudioPlayer({ audio, storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},
    urls:{createObjectURL:()=>`blob:${Math.random()}`,revokeObjectURL:url=>revoked.push(url)},
    platform:{mediaSession:session,MediaMetadata:class {constructor(data){Object.assign(this,data);}}},
    deadline:()=>expired, beforePlay:()=>prepared++ });
  const attach = id=>{player.attach({id,title:id},{name:'chapter.m4a',blob:{}});audio.duration=600;audio.emit('loadedmetadata');};
  return {audio,data,actions,revoked,session,player,attach,setExpired:v=>{expired=v;},prepared:()=>prepared};
}
test('audio restores seconds, saves on pause, and isolates book positions',async()=>{
  const {audio,data,player,attach}=setup();data.set('book-audio:position:one','120');attach('one');assert.equal(audio.currentTime,120);
  await player.play();audio.currentTime=185;player.pause();assert.equal(data.get('book-audio:position:one'),'185');
  attach('two');assert.equal(audio.currentTime,0);attach('one');assert.equal(audio.currentTime,185);
});
test('real playback sets metadata and responds to lock-screen actions',async()=>{
  const {audio,player,attach,actions,session,prepared}=setup();attach('one');await player.play();
  assert.equal(prepared(),1);assert.equal(session.metadata.title,'one');assert.equal(session.playbackState,'playing');
  actions.seekforward({});assert.equal(audio.currentTime,15);actions.seekto({seekTime:900});assert.equal(audio.currentTime,600);
  actions.seekbackward({seekOffset:30});assert.equal(audio.currentTime,570);actions.pause();assert.equal(player.isPlaying,false);
  await actions.play();assert.equal(player.isPlaying,true);
});
test('rate changes immediately with pitch preservation, independently from TTS',()=>{
  const {player,audio,attach,data}=setup();attach('one');player.setRate(3);assert.equal(audio.playbackRate,3);assert.equal(audio.preservesPitch,true);
  assert.equal(data.get('book-audio:rate'),'3');player.setRate(9);assert.equal(player.rate,4);
});
test('saving background position does not pause playback',async()=>{
  const {player,attach}=setup();attach('one');await player.play();player.save();assert.equal(player.isPlaying,true);
});
test('failed play becomes actionable and stale completion cannot overwrite new source',async()=>{
  const {player,audio,attach}=setup();attach('one');audio.play=()=>Promise.reject(new Error('not allowed'));
  await player.play();assert.equal(player.isPlaying,false);assert.match(player.notice,/未啟動/);
  let reject;audio.play=()=>new Promise((_,r)=>{reject=r;});const pending=player.play();attach('two');reject(new Error('old'));
  await pending;assert.equal(player.bookId,'two');assert.equal(player.notice,'');
});
test('detaching clears media handlers and revokes the old object URL',async()=>{
  const {player,attach,revoked,actions}=setup();attach('one');await player.play();player.detach();assert.equal(revoked.length,1);assert.equal(actions.play,null);assert.equal(player.bookId,null);
});
test('expired sleep deadline prevents a new background play command',async()=>{
  const {player,attach,setExpired,prepared}=setup();attach('one');setExpired(true);await player.play();assert.equal(player.isPlaying,false);assert.equal(prepared(),0);
});
test('time formatting supports long novels and missing duration',()=>{
  assert.equal(audioTime(3661),'1:01:01');assert.equal(audioTime(NaN),'0:00');assert.equal(audioTime(65),'1:05');
});
