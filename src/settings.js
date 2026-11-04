export const defaults = Object.freeze({timeZone:'Asia/Seoul',dailyTime:'08:00',weeklyTime:'20:00',weeklyDay:0,dailyEnabled:true,weeklyEnabled:true});
export function validateSettings(input) {
 if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('설정 형식을 확인하세요.');
 if(Object.keys(input).some(k=>!Object.hasOwn(defaults,k)))throw new Error('지원하지 않는 설정입니다.');
 const s={...defaults,...input};
 try {new Intl.DateTimeFormat('en',{timeZone:s.timeZone}).format();}catch{throw new Error('시간대를 확인하세요.');}
 for(const k of ['dailyTime','weeklyTime'])if(typeof s[k]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s[k]))throw new Error('시각을 HH:MM으로 입력하세요.');
 if(!Number.isInteger(s.weeklyDay)||s.weeklyDay<0||s.weeklyDay>6)throw new Error('요일을 0(일)~6(토)로 입력하세요.');
 for(const k of ['dailyEnabled','weeklyEnabled'])if(typeof s[k]!=='boolean')throw new Error('알림 활성 여부를 확인하세요.');
 return s;
}
export function settingsText(s){return `시간대 ${s.timeZone}\n일일점검 ${s.dailyEnabled?s.dailyTime:'중지'}\n주간점검 ${s.weeklyEnabled?['일','월','화','수','목','금','토'][s.weeklyDay]+'요일 '+s.weeklyTime:'중지'}`;}
export function settingsCommand(arg,current){
 if(!arg)return null;
 const [key,value,...rest]=arg.split(/\s+/);if(rest.length||!Object.hasOwn(defaults,key))throw new Error('설정 항목과 값을 확인해주세요. 예: 매일 점검을 오전 7시 반으로 바꿔줘');
 let v=value;if(['dailyEnabled','weeklyEnabled'].includes(key)){if(!['on','off'].includes(v))throw new Error('설정 활성값은 on 또는 off입니다.');v=v==='on';}if(key==='weeklyDay')v=Number(v);
 return validateSettings({...current,[key]:v});
}
