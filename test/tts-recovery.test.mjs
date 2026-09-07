import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { TtsPlaybackGeneration } from '../src/tts-playback-generation.js';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function setup() {
  const saved = new Map(), timers = new Map(), spoken = [];
  let nextTimer = 0;
  const state = {currentBook: {id:'one', paragraphs:['甲'.repeat(600), '第二段'], progressPara:0}, pages:[{startPara:0}], currentPage:0, ttsVolume:1};
  const context = vm.createContext({state, TtsPlaybackGeneration, console,
    localStorage: {getItem:k=>saved.get(k) ?? null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)},
    SpeechSynthesisUtterance: class {constructor(text){this.text=text;}},
    speechSynthesis:{getVoices:()=>[],speak:u=>spoken.push(u),cancel:()=>{},speaking:true,pending:true},
    bookAudio:{pause(){},releaseSession(){}},
    clampSpeechRate:()=>4, performance:{now:()=>1000},
    clearTimeout:id=>timers.delete(id), setTimeout:fn=>{timers.set(++nextTimer,fn);return nextTimer;},
    renderTtsState(){},renderPanel(){},highlightPara(){},saveProgressFromPage(){},toast(){},checkSleepDeadline:()=>false,
    wakeLock:{request:async()=>{},release:async()=>{}}
  });
  vm.runInContext(source.slice(source.indexOf('class SpeechQueue {'), source.indexOf('const tts = new SpeechQueue();'))+'\nglobalThis.queue = new SpeechQueue();',context);
  const q=context.queue;q.isSupported=()=>true;
  return {q,spoken,timers,saved,state};
}
test('long paragraph resumes the interrupted segment after background and reload',()=>{
  const {q,spoken,saved}=setup();q.play();spoken[0].onstart();spoken[0].onend();
  assert.equal(q.activeSegment.part,1);
  const staleEnd=spoken[1].onend;
  q.suspendForBackground();q.restorePosition();q.play();
  assert.equal(q.activeSegment.part,1);assert.equal(spoken.at(-1).text.length,260);
  const current=q.currentUtterance;staleEnd();assert.equal(q.currentUtterance,current);
  assert.equal(JSON.parse(saved.get('tts-position:one')).part,1);
});
test('stuck pending engine returns controls without skipping content',()=>{
  const {q,timers}=setup();q.play();[...timers.values()][0]();
  assert.equal(q.state,'idle');assert.equal(q.currentUtterance,null);
  q.play();assert.equal(q.activeSegment.part,0);
});
test('speech errors preserve the failed segment',()=>{
  const {q,spoken}=setup();q.play();spoken[0].onend();
  spoken[1].onerror({error:'synthesis-failed'});assert.equal(q.state,'paused');
  q.play();assert.equal(q.activeSegment.part,1);
});
test('diagnostics preserve listening cursor on completion and interruption',()=>{
  const {q,spoken,saved}=setup();q.play();spoken[0].onend();q.pause();
  const before=saved.get('tts-position:one');q.testRate();spoken.at(-1).onstart();spoken.at(-1).onend();
  assert.equal(q.diagnosticResults.length,1);assert.equal(saved.get('tts-position:one'),before);
  q.testRate();q.suspendForBackground();q.play();assert.equal(q.activeSegment.part,1);
});
test('leaving a book preserves its checkpoint, explicit stop clears it',()=>{
  const {q,saved}=setup();q.play();q.stop(true);assert.ok(saved.has('tts-position:one'));
  q.restorePosition();q.play();q.stop();assert.equal(saved.has('tts-position:one'),false);
});
test('cursor is isolated per book and malformed storage is ignored',()=>{
  const {q,state,saved}=setup();q.play();q.pause();state.currentBook.id='two';q.restorePosition();
  assert.equal(q.resumePara,null);saved.set('tts-position:two','bad json');q.restorePosition();assert.equal(q.resumePara,null);
});
