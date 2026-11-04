import {validDay} from './time.js';
import {formatList} from './format.js';

// Input tasks are loaded by the family-scoped Store, never by a model-supplied family ID.
export function retrieveTasks(tasks, query, now, timeZone){
 const keys=['kind','status','from','to','person','search'];
 if(!query||typeof query!=='object'||(Object.keys(query).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(query,k)))||query.kind!=='task_list'||!['active','done','cancelled','all'].includes(query.status))throw new Error('조회 범위를 확인하지 못했어요. 다시 말씀해주세요.');
 for(const k of ['from','to'])if(query[k]!=null&&(typeof query[k]!=='string'||!validDay(query[k])))throw new Error('조회 날짜를 확인하지 못했어요.');
 if(query.from&&query.to&&query.from>query.to)throw new Error('조회 기간의 시작과 끝을 확인해주세요.');
 for(const k of ['person','search'])if(query[k]!=null&&(typeof query[k]!=='string'||!query[k].trim()||query[k].length>120))throw new Error('조회 조건을 확인하지 못했어요.');
 const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s/g,'');
 const selected=tasks.filter(t=>query.status==='all'||(query.status==='active'?!['done','cancelled'].includes(t.status):t.status===query.status))
 .filter(t=>(!query.from||(t.endDate||t.dueDate)>=query.from)&&(!query.to||t.dueDate&&t.dueDate<=query.to))
 .filter(t=>!query.person||normalize(t.person).includes(normalize(query.person))||normalize(t.assignee).includes(normalize(query.person)))
 .filter(t=>!query.search||normalize(t.title).includes(normalize(query.search)))
 .sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999')||(a.time||'99:99').localeCompare(b.time||'99:99'));
 const conditions=[{active:'미완료',done:'완료',cancelled:'취소',all:'모든 상태'}[query.status],query.from&&query.from+'부터',query.to&&query.to+'까지',query.person&&'관련: '+query.person,query.search&&'제목: '+query.search].filter(Boolean).join(' · ');
 // Bound output before rendering; announce the actual coverage rather than silently truncating.
 const shown=[];let size=0;
 for(const t of selected){const length=JSON.stringify(t).length;if(shown.length>=100||size+length>18000)break;shown.push(t);size+=length;}
 const reply='📋 조회 조건 · '+conditions+'\n\n'+(selected.length?formatList(shown,query.status==='active'?'all':'query',now,timeZone):'해당 조건의 일정·할 일이 없어요.')+(shown.length<selected.length?'\n\n전체 '+selected.length+'건 중 '+shown.length+'건을 표시했어요. 기간이나 대상을 좁혀 이어서 조회해주세요.':'');
 return {tasks:shown,reply,total:selected.length,truncated:shown.length<selected.length};
}
