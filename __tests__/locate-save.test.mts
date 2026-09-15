import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

function harness(initialCodes = ['A1']) {
  const state: any[] = [3, 'Bay 1', false, 'full', initialCodes, '', null, false, false, true];
  let index = 0, calls = 0;
  const pending: {resolve:(value:any)=>void; reject:(error:Error)=>void}[] = [];
  const alerts: any[] = [];
  const compile = (source:string) => ts.transpileModule(source,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,
  }}).outputText;
  function helper(path:string) {const box={exports:{}};runInNewContext(compile(readFileSync(path,'utf8')),box);return box.exports;}
  const deps: Record<string,any> = {
    react:{useState:(value:any)=>{
      const slot=index++; if(slot>=state.length)state[slot]=value;
      return [state[slot],(next:any)=>{state[slot]=typeof next==='function'?next(state[slot]):next;}];
    },useRef:(value:any)=>({current:value}),useEffect:()=>{}},
    'react-native':{Alert:{alert:(...args:any[])=>alerts.push(args)},Vibration:{vibrate:()=>{}}},
    'expo-haptics':{notificationAsync:async()=>{},impactAsync:async()=>{},NotificationFeedbackType:{},ImpactFeedbackStyle:{}},
    'expo-router':{useRouter:()=>({replace:()=>{}})},
    '@/store':{useStore:()=>({boot:{assets:{A1:{c:'Customer',or:1}}},refresh:async()=>{},outbox:{scans:[]}})},
    '@/ui':{useBottomInset:()=>0},
    '@/live':{useLiveData:()=>{}},
    '@/sound':{playScanAccept:()=>{},playScanAlert:()=>{},playSubmitSuccess:()=>{}},
    '@/db':{cacheSet:async()=>{}},
    '@/api':{postFill:()=>{calls++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));}},
    '@/interlock':helper('src/interlock.ts'),
    '../../src/shelf-admit':helper('src/shelf-admit.ts'),
  };
  let source=readFileSync('app/(tabs)/warehouse.tsx','utf8');
  assert.ok(source.includes('  const field = {'));
  source=source.replace('  const field = {','  return {save,add};\n  const field = {');
  const box={exports:{} as any,require:(name:string)=>deps[name]??{},console};
  runInNewContext(compile(source),box);
  const screen=box.exports.default();
  return {screen,state,alerts,calls:()=>calls,pending,
    result:{updated:1,closed:0,closedCustomers:[],unknown:[],results:[]}};
}
test('two rapid Save callbacks submit the Locate shelf once',async()=>{
  const h=harness();
  const first=h.screen.save(),second=h.screen.save();
  const count=h.calls();
  for(const p of h.pending)p.resolve(h.result);
  await Promise.all([first,second]);
  assert.equal(count,1);
});
test('failed save releases lock so driver can retry',async()=>{
  const h=harness();
  const first=h.screen.save();
  h.pending[0].reject(new Error('offline'));await first;
  const retry=h.screen.save();
  assert.equal(h.calls(),2);
  h.pending[1].resolve(h.result);await retry;
});
test('no-return warning confirmation counts an asset only once',()=>{
  const h=harness([]);
  h.screen.add('A1');h.screen.add('A1');
  assert.equal(h.alerts.length,1);
  const accept=h.alerts[0][2].find((button:any)=>button.text==='Shelve it anyway');
  accept.onPress();h.screen.add('A1');accept.onPress();
  assert.deepEqual(Array.from(h.state[4]),['A1']);
});
