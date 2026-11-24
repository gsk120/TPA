import {today} from './time.js';
import {lastScheduleDay,parseRule,wallTime} from './recurrence.js';
export const statusLabel={open:'미완료',in_progress:'진행 중',waiting:'대기',done:'완료',cancelled:'취소'};
const clean=value=>String(value||'').replace(/[\r\n]+/g,' ').trim();
export function dateLabel(day){if(!day)return '날짜 미정';const d=new Date(day+'T12:00:00Z');return `${d.getUTCFullYear()}년 ${d.getUTCMonth()+1}월 ${d.getUTCDate()}일(${'일월화수목금토'[d.getUTCDay()]})`;}
export function clockLabel(clock){if(!clock)return '시간 미정';const [h,m]=clock.split(':').map(Number);return `${h<12?'오전':h===12?'낮':'오후'} ${h%12||12}시${m?' '+m+'분':''}`;}
const hasDeadline=task=>['task','decision'].includes(task.kind);
function dateTimeLabel(task) {
 const date = dateLabel(task.dueDate);
 if (hasDeadline(task) && task.dueDate) return date + (task.time ? ' ' + clockLabel(task.time) + '까지' : ' · 이날까지');
 const time = task.timeType === 'all_day' || task.recurrence?.allDay ? '종일'
  : task.timeType === 'unknown' ? '시간 미정' : task.time ? clockLabel(task.time) : '';
 const last=lastScheduleDay(task);
 return date + (time ? ' ' + time : '') + (last>task.dueDate ? ' ~ ' + dateLabel(last) : '');
}
function repeatLabel(recurrence) {
 if (!recurrence?.rule) return '';
 let rule;
 try { rule=parseRule(recurrence.rule,recurrence.dateAnchored); }
 catch { return recurrence.readOnly ? '\n반복: Google Calendar에서 규칙 확인' : ''; }
 const unit={DAILY:'일',WEEKLY:'주',MONTHLY:'월',YEARLY:'년'}[rule.frequency];
 const cadence=rule.interval===1 ? '매'+unit : rule.interval+(unit==='월'?'개월':unit)+'마다';
 const anchorDay=recurrence.anchor.slice(0,10);
 const weekdays=rule.byDay ?? (rule.frequency==='WEEKLY' ? [new Date(anchorDay+'T00:00:00Z').getUTCDay()] : []);
 const days=weekdays.map(day=>'일월화수목금토'[day]+'요일').join(', ');
 const monthDays=(rule.byMonthDay ?? [Number(anchorDay.slice(8))])
  .map(day=>day>0 ? day+'일' : day===-1?'말일':'뒤에서 '+(-day)+'번째 날').join(', ');
 const on={WEEKLY:days,MONTHLY:monthDays,YEARLY:(rule.byMonth ?? Number(anchorDay.slice(5,7)))+'월 '+monthDays}[rule.frequency];
 const until=rule.until && (recurrence.dateAnchored ? rule.until : wallTime(Date.parse(rule.until),recurrence.seriesTimeZone).slice(0,10));
 const end=until ? dateLabel(until)+'까지' : rule.count ? '총 '+rule.count+'회' : '종료일 없이 반복';
 return '\n반복: '+[cadence,on,end].filter(Boolean).join(' · ');
}
export function displayTask(t,{deadline=true}={}){
 const title=clean(t.title)+(t.recurrence?.readOnly?' (읽기 전용)':''),isTask=hasDeadline(t);
 const last=lastScheduleDay(t);
 const period=last>t.dueDate?t.dueDate+'~'+last:'';
 let line;
 if(t.timeType==='all_day'||t.recurrence?.allDay)line='• '+['종일',title,period].filter(Boolean).join(' · ');
 else if(t.timeType==='condition')line='• '+clean(t.timeNote)+' · '+title;
 else if(t.timeType==='unknown'&&isTask)line='☐ '+title+' · 시간 미정'+(deadline&&t.dueDate?' · 이날까지':'');
 else if(isTask)line=`☐ ${title}${t.time?' · '+clockLabel(t.time)+'까지':deadline&&t.dueDate?' · 이날까지':''}`;
 else if(t.timeType==='range')line='• '+[clockLabel(t.time),title,period,clean(t.timeNote)].filter(Boolean).join(' · ');
 else if(t.kind==='registration')line=`• ${clockLabel(t.time)} · ${title}${t.timeNote?.includes('접수')?' · '+clean(t.timeNote):' · 접수 시작'}`;
 else if(t.kind==='event'){
  const note=clean(t.timeNote);
  const visitStatus=t.dueDate&&(period?'방문일 미정':'방문 시간 미정');
  line='• '+[t.time&&clockLabel(t.time),title,period,note||(!t.time&&visitStatus)].filter(Boolean).join(' · ');
 }
 else line='• '+[t.time?clockLabel(t.time):clean(t.timeNote)||'시간 미정',title,period].filter(Boolean).join(' · ');
 if(t.timeNote&&(t.time||isTask)&&!['range','condition'].includes(t.timeType)&&!['registration','event'].includes(t.kind))line+=' · '+clean(t.timeNote);
 if(['waiting','in_progress','done','cancelled'].includes(t.status))line+=' · '+statusLabel[t.status];
 if(t.actualDeadline)line+=' · 실제 만기 '+t.actualDeadline;
 return line;
}
export function groupTasks(tasks,{now=new Date(),timeZone='Asia/Seoul',showOverdue=true,deadline=true}={}){
 const day=today(now,timeZone);const sorted=[...tasks].sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999')||(a.time||'99:99').localeCompare(b.time||'99:99')||a.title.localeCompare(b.title,'ko'));
 const groups=new Map();
 for(const t of sorted){const past=showOverdue&&t.dueDate&&lastScheduleDay(t)<day;const key=t.dueDate?`${past?'⚠️ 기한 경과 / 지난 일정 결과 미확인 · ':''}${dateLabel(t.dueDate)}`:t.status==='waiting'?'날짜 미정 · 안내 대기':'날짜 미정';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(displayTask(t,{deadline}));}
 return [...groups].map(([date,lines])=>date+'\n'+lines.join('\n')).join('\n\n')||'해당하는 일정·할 일이 없어요.';
}
export function formatList(tasks,mode,now=new Date(),timeZone='Asia/Seoul'){
 const title={today:'오늘 일정·할 일',week:'앞으로 7일 일정·할 일',all:'남은 일정·할 일'}[mode]||'일정·할 일';
 const heading=`📅 ${title} · ${dateLabel(today(now,timeZone))}\n기준 시간대: ${timeZone}`;
 const body=mode==='today'?tasks.map(t=>displayTask(t,{deadline:false})).join('\n'):groupTasks(tasks,{now,timeZone});
 const due=tasks.filter(t=>['task','decision'].includes(t.kind)&&t.dueDate===today(now,timeZone)).length;
 return heading+'\n\n'+(body||'해당하는 일정·할 일이 없어요.')+(mode==='today'&&due?`\n\n오늘까지 마감인 과업 ${due}개가 있어요.`:'');
}
export function formatReceipt(changes){return '✅ 저장 완료\n\n'+changes.map(c=>`${c.after.status==='done'?'완료':c.after.status==='cancelled'?'취소':c.before?'변경':'추가'} · ${clean(c.after.title)}\n${dateTimeLabel(c.after)}${c.after.timeNote?' · '+clean(c.after.timeNote):''}${['task','decision'].includes(c.after.kind)?' · 마감':''}`).join('\n\n');}
export function formatDetail(t,{showId=false}={}){return `🔎 일정 상세\n\n${clean(t.title)}\n${dateTimeLabel(t)}${repeatLabel(t.recurrence)}\n상태: ${statusLabel[t.status]||t.status}${t.timeNote?'\n시각 안내: '+clean(t.timeNote):''}${t.person?'\n관련 가족: '+clean(t.person):''}${t.assignee?'\n담당자: '+clean(t.assignee):''}${t.actualDeadline?'\n실제 만기: '+t.actualDeadline:''}${t.notes?'\n메모: '+t.notes:''}${showId?'\n\nID: '+t.id:''}`;}
export function headingEntities(text){let offset=0;const entities=[];for(const line of text.split('\n')){if(line.length&&line.length<=180&&((offset===0&&/^(📅|✅|🔎|🔔|⚠️|📋|⚙️|❓)/u.test(line))||/^\d{4}년 \d{1,2}월 \d{1,2}일\([일월화수목금토]\)$/.test(line)||/^(날짜 미정|⚠️ 기한 경과|오늘$|내일 준비$|앞으로 14일$|지난 7일 완료 기록$|대기·날짜 미정$|기한 경과 \/ 지난 일정 결과 미확인$)/.test(line)))entities.push({type:'bold',offset,length:line.length});offset+=line.length+1;}return entities.slice(0,90);}
