import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {ControlJournal,HumanAgent} from '../plugins/become-human/driver.mjs';
import {AutonomyStore} from '../plugins/become-human/autonomy-store.mjs';
import {defaultQuietHours,quietUntil} from '../plugins/become-human/quiet-hours.mjs';
import {runStatus} from '../plugins/become-human/run-status.mjs';
import {wakeForPluginEvent} from '../plugins/become-human/plugin-events.mjs';
import {ReminderStore} from '../plugins/become-human/reminders.mjs';
import {HumanOnboarding} from '../plugins/become-human-web/onboarding.mjs';

const night={...defaultQuietHours,timeZoneOffsetMinutes:480,enabled:true};
const instant=clock=>Date.parse('2026-11-'+clock+'+08:00');
const open=instant('19T08:00:00'),minute=60000;

function scheduler(t,now){
  t.mock.timers.enable({apis:['Date','setTimeout'],now});
  const journal=new ControlJournal(':memory:'),id='quiet-test';
  t.after(()=>journal.close());
  journal.ensure(id);journal.set(id,'running');journal.put(id,'remaining',null);
  const events=[],factory={journal,config:{intervalMs:10*minute,interactiveOnly:true},autonomy:{settings:()=>night}};
  const agent=Object.assign(Object.create(HumanAgent.prototype),{
    id,factory,ready:true,inbox:{nextTurn:[],nextStep:[]},pumps:0,pump(){this.pumps++;},
    ctx:{agents:{withoutInitiator:fn=>fn()},sessionProjections:{stateOf:()=>null}},
    session:{id,snapshotEvents:()=>events,append(type,data){events.push({seq:events.length+1,time:Date.now(),type,data});}},flush:async()=>{}
  });
  factory.handles=new Set([{agent}]);
  return agent;
}

test('local start is inclusive, end exclusive, including midnight and fractional UTC offsets',()=>{
  assert.equal(quietUntil(night,instant('18T21:59:59.999')),null);
  for(const time of ['18T22:00:00','19T00:00:00','19T07:59:59.999'])assert.equal(quietUntil(night,instant(time)),open);
  assert.equal(quietUntil(night,open),null);
  const daytime={quietStart:13,quietEnd:15,timeZoneOffsetMinutes:-210};
  assert.equal(quietUntil(daytime,Date.parse('2026-11-18T13:00:00-03:30')),Date.parse('2026-11-18T15:00:00-03:30'));
  assert.equal(quietUntil({...night,quietEnd:22},instant('18T23:00:00')),null);
});

test('arm skips all nighttime ticks and wakes once at the end, then restores cadence',t=>{
  const now=instant('18T21:57:00'),agent=scheduler(t,now),j=agent.factory.journal;
  j.tickAt(agent.id,now+10*minute);agent.arm();
  assert.equal(agent.desired().next_tick,open);
  t.mock.timers.tick(open-now-1);assert.equal(agent.pumps,0);
  t.mock.timers.tick(1);assert.equal(agent.pumps,1);assert.equal(agent.desired().next_tick,open+10*minute);
  t.mock.timers.tick(10*minute);assert.equal(agent.pumps,2);
  assert.equal(j.db.prepare("SELECT count(*) AS n FROM audit WHERE kind='timer-wake'").get().n,2);
});

test('quiet hours follow the saved region across seasons, skipped and repeated hours',()=>{
  const zone={quietStart:22,quietEnd:8,timeZoneOffsetMinutes:-240,quietTimeZone:'America/New_York'};
  const until=(time,overrides)=>quietUntil({...zone,...overrides},Date.parse(time));
  assert.equal(until('2026-11-19T12:30Z'),Date.parse('2026-11-19T13:00Z'));
  assert.equal(until('2026-07-15T02:30Z'),Date.parse('2026-07-15T12:00Z'));
  assert.equal(until('2026-03-08T05:10Z',{quietEnd:2}),Date.parse('2026-03-08T07:00Z'));
  assert.equal(until('2026-11-01T04:10Z',{quietEnd:1}),Date.parse('2026-11-01T05:00Z'));
  assert.equal(until('2026-11-01T05:30Z',{quietStart:1,quietEnd:2}),Date.parse('2026-11-01T07:00Z'));
  const status=runStatus({desired:'running',autonomy:{settings:{...zone,enabled:true}}},Date.parse('2026-11-01T04:10Z'));
  assert.match(status.text,/11-01 08:00/);
  assert.throws(()=>until('2026-07-15T02:30Z',{quietTimeZone:'invalid/region'}),/INVALID_QUIET_TIME_ZONE/);
});

test('legacy onboarding zone follows the matching session and preserves explicit fixed offsets',()=>{
  const j=new ControlJournal(':memory:');
  try{
    const store=new AutonomyStore(j,{});store.legacyQuietHours={sessionId:'legacy',zone:'America/New_York',offset:-240};
    j.put('legacy','autonomySettings',{timeZoneOffsetMinutes:-240});
    assert.equal(store.settings('legacy').quietTimeZone,'America/New_York');
    assert.equal(store.settings('different').quietTimeZone,null);
    j.put('legacy','autonomySettings',{timeZoneOffsetMinutes:-300});
    assert.equal(store.settings('legacy').quietTimeZone,null);
    j.put('legacy','autonomySettings',{timeZoneOffsetMinutes:-240,quietTimeZone:null});
    assert.equal(store.settings('legacy').quietTimeZone,null);
  }finally{j.close();}
});

test('late callback in quiet hours, startup and queued plugin events do not start an idle turn',async t=>{
  const agent=scheduler(t,instant('18T23:30:00')),j=agent.factory.journal;
  j.tickAt(agent.id,instant('18T21:59:00'));agent.due();agent.arm();wakeForPluginEvent(agent.factory,agent.id);
  await agent.drive(new AbortController().signal);
  assert.equal(agent.pumps,0);assert.equal(j.value(agent.id,'pluginEventLastWake',null),null);
  assert.equal(agent.session.snapshotEvents().length,0);assert.equal(j.db.prepare('SELECT count(*) n FROM attempt').get().n,0);
  assert.equal(agent.desired().next_tick,open);assert.equal(agent.desired().desired,'running');
  j.set(agent.id,'paused');t.mock.timers.tick(open-Date.now());assert.equal(agent.pumps,0);
});

test('a reminder uses its independent timer inside the quiet window and commits once',async t=>{
  const agent=scheduler(t,instant('18T23:00:00')),j=agent.factory.journal;
  const reminders=agent.factory.reminders=new ReminderStore(j);
  reminders.create(agent.id,{requestId:'quiet-reminder-test',dueAt:Date.now()+minute,text:'测试提醒'});
  agent.arm();agent.armReminder();t.mock.timers.tick(minute);assert.equal(agent.pumps,1);
  await agent.drive(new AbortController().signal);await agent.drive(new AbortController().signal);
  assert.equal(j.db.prepare("SELECT count(*) n FROM outbox WHERE kind='assistant' AND text LIKE '%测试提醒%'").get().n,1);
  assert.equal(j.db.prepare('SELECT count(*) n FROM attempt').get().n,0);
  assert.equal(agent.desired().next_tick,open);
});

test('waking late after the quiet window coalesces missed intervals into one check',t=>{
  const agent=scheduler(t,open+45*minute),j=agent.factory.journal;
  j.tickAt(agent.id,open);agent.due();agent.due();agent.arm();
  assert.equal(agent.pumps,1);assert.equal(agent.desired().next_tick,Date.now()+10*minute);
  const event=j.db.prepare("SELECT data FROM audit WHERE kind='timer-wake'").get();
  assert.equal(JSON.parse(event.data).lateMs,45*minute);
});

test('owner input and explicit single check can enter the turn during quiet hours',async t=>{
  const agent=scheduler(t,instant('18T22:10:00'));
  // Stop at the turn boundary to distinguish admission from model/network behavior.
  const entered=new Error('reached explicit turn');
  agent.ctx.sessionProjections.stateOf=()=>{throw entered;};
  agent.inbox.nextTurn.push({role:'user'});await assert.rejects(agent.drive(new AbortController().signal),entered);
  agent.inbox.nextTurn=[];agent.factory.journal.put(agent.id,'remaining',1);
  agent.manualCheck=true;await assert.rejects(agent.drive(new AbortController().signal),entered);
  await agent.drive(new AbortController().signal);
});

test('onboarding persists selected hours before start and accepts legacy inputs without hours',async t=>{
  for(const [n,selection,expected] of [[1,{quietStart:12,quietEnd:14},[12,14]],[2,{},[22,8]],[3,{quietStart:0,quietEnd:0},[0,0]]]){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'human-quiet-')),setup=new HumanOnboarding(dir,'0.2.0-rc.2');
    setup.config={runtimeHome:dir,intervalMs:600000};Object.defineProperty(setup,'supported',{value:true});
    setup.refresh=async()=>{};setup.models=[{provider:'test',model:'test',credentialReady:true}];
    const state={sessionId:'synthetic',desired:'paused',management:{revision:1,profile:{}},autonomy:{settings:{}}};
    let starts=0;
    setup.attach({config:{},start:async()=>{},state:async()=>state,recordLifecycle(){},async control(input){
      if(input.op==='autonomy-configure')state.autonomy.settings=input.settings;
    }},async()=>{assert.deepEqual([state.autonomy.settings.quietStart,state.autonomy.settings.quietEnd],expected);assert.equal(state.autonomy.settings.quietTimeZone,input.timeZone);starts++;});
    const input={requestId:'test-case-'+n,expectedRevision:1,provider:'test',model:'test',personaPreset:'zhiqiu',budgetPreset:'low',ownerName:'',timeZone:'Asia/Shanghai',startAutonomy:true,...selection};
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    for(const invalid of [-1,24,1.5,null,'8'])await assert.rejects(setup.complete({...input,quietEnd:invalid}),/INVALID_SETUP_REQUEST/);
    await setup.complete(input);await setup.complete(input);assert.equal(starts,1);
    const record=JSON.parse(await fs.readFile(setup.filename,'utf8'));assert.deepEqual([record.input.quietStart,record.input.quietEnd],expected);
  }
});
