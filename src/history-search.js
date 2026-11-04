import {today,addDays,validDay} from './time.js';
import {searchTerms} from './context.js';
export function historyRequest(text,now=new Date(),timeZone='Asia/Seoul'){
 if(/바꿔|변경해|미뤄줘|취소해|추가해|등록해|완료했어|완료(?:\s*처리)?해줘/.test(text))return null;
 if(!/지난\s*달|지난\s*주|작년|과거|이력|갱신했|연장했|완료했지|미뤘|분석|기록|언제/.test(text))return null;
 const day=today(now,timeZone);let from=null,to=null;
 const monthStart=day.slice(0,7)+'-01';
 if(/지난\s*달/.test(text)){to=monthStart;from=addDays(monthStart,-1).slice(0,7)+'-01';}
 else if(/지난\s*주/.test(text)){const weekday=new Date(day+'T12:00:00Z').getUTCDay();to=addDays(day,-((weekday+6)%7));from=addDays(to,-7);}
 else if(/작년/.test(text)){from=(Number(day.slice(0,4))-1)+'-01-01';to=day.slice(0,4)+'-01-01';}
 else{const match=text.match(/(20\d{2})[년.\/-]\s*(\d{1,2})(?:월|[.\/-]|\b)/);if(match){from=match[1]+'-'+match[2].padStart(2,'0')+'-01';if(!validDay(from))return null;to=addDays(addDays(from,32).slice(0,7)+'-01',0);}}
 const noise=/^(지난달|지난주|작년|과거|이력|어떤|언제|많이|미뤘|미룬|미완료|분석|기록|갱신했|연장했|완료했|내용|정리|일들|했던|올해)/;
 const terms=searchTerms(text).filter(t=>!noise.test(t)&&!['알려','보여','남긴'].includes(t));
 return {from,to,terms:terms.slice(0,8),timeZone,dateBasis:'변경 기록 시각',limit:24};
}
