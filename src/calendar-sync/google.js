import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export function refreshTokenReader(env,{platform=process.platform,run=exec}={}) {
  return async signal => {
    if (platform !== 'darwin') return env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    const familyId=env.CALENDAR_SYNC_FAMILY_ID;
    if (!familyId?.trim()) return undefined;
    try {
      const {stdout}=await run('/usr/bin/security',
        ['find-generic-password','-s','TPA Google Calendar','-a',familyId,'-w'],
        {signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      return stdout.trim() || undefined;
    } catch {
      throw new GoogleError(401);
    }
  };
}

export function calendarSettings(env = process.env) {
  if (env.CALENDAR_SYNC_ENABLED !== 'true') return null;
  const {CALENDAR_SYNC_FAMILY_ID:familyId, GOOGLE_CALENDAR_ID:calendarId,
    GOOGLE_CALENDAR_CLIENT_ID:clientId, GOOGLE_CALENDAR_CLIENT_SECRET:clientSecret,
    CALENDAR_SYNC_DATA_KEY:dataKey} = env;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(familyId ?? '') ||
      !calendarId?.trim() || calendarId === 'primary' || !clientId || !clientSecret ||
      !/^[a-f0-9]{64}$/i.test(dataKey ?? '')) return null;
  const readToken=refreshTokenReader(env);
  const refreshToken=async signal=>{
    const token=await readToken(signal);
    if (!token?.trim() || /[<>]/.test(token)) throw new GoogleError(401);
    return token;
  };
  return {familyId,calendarId,clientId,clientSecret,key:Buffer.from(dataKey,'hex'),refreshToken,
    allowDelete:env.CALENDAR_SYNC_ALLOW_DELETE === 'true'};
}

export class GoogleError extends Error {
  constructor(status, reason) {
    super('Google Calendar request failed');
    this.status = status;
    this.rateLimit = status === 403 && ['rateLimitExceeded','userRateLimitExceeded','quotaExceeded'].includes(reason);
  }
}

export function calendarClient(settings, signal, request = fetch) {
  let access;
  let expiresAt = 0;
  async function json(url, options) {
    const response = await request(url,{...options,redirect:'error',
      signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new GoogleError(response.status,body.error?.errors?.[0]?.reason);
    }
    return response.status === 204 ? null : response.json();
  }
  async function token() {
    if (access && Date.now() < expiresAt) return access;
    try {
      const result = await json('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({
        client_id:settings.clientId,client_secret:settings.clientSecret,
        refresh_token:await settings.refreshToken(signal),grant_type:'refresh_token'
      })});
      if (!result.access_token) throw new GoogleError(401);
      access = result.access_token;
      expiresAt = Date.now() + Math.max(0,(Number(result.expires_in)-60)*1000);
      return access;
    } catch (error) {
      if (error.status === 400) throw new GoogleError(401);
      throw error;
    }
  }
  const base = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(settings.calendarId) + '/events';
  async function call(path, method = 'GET', body, etag) {
    for (let attempt=0; ; attempt++) {
      try {
        return await json(base+path,{method,headers:{Authorization:'Bearer '+await token(),
          ...(body && {'Content-Type':'application/json'}),...(etag && {'If-Match':etag})},
          ...(body && {body:JSON.stringify(body)})});
      } catch (error) {
        if (error.status !== 401 || attempt) throw error;
        access = null;
      }
    }
  }
  const path = id => '/' + encodeURIComponent(id);
  return {
    list(syncToken,pageToken) {
      const query = new URLSearchParams({singleEvents:'false',showDeleted:'true',maxResults:'250'});
      if (syncToken) query.set('syncToken',syncToken);
      if (pageToken) query.set('pageToken',pageToken);
      return call('?'+query);
    },
    get:id => call(path(id)),
    instancePage(id,{timeMin,timeMax,pageToken}={}) {
      const query=new URLSearchParams({showDeleted:'true',maxResults:'250'});
      if (timeMin) query.set('timeMin',timeMin);
      if (timeMax) query.set('timeMax',timeMax);
      if (pageToken) query.set('pageToken',pageToken);
      return call(path(id)+'/instances?'+query);
    },
    instances:(id,originalStart) => {
      const query=new URLSearchParams({showDeleted:'true'});
      if (originalStart.length===10) {
        const day=Date.parse(originalStart+'T00:00:00Z');
        query.set('timeMin',new Date(day-86400000).toISOString());
        query.set('timeMax',new Date(day+172800000).toISOString());
      } else query.set('originalStart',originalStart);
      return call(path(id)+'/instances?'+query);
    },
    create:event => call('','POST',{...event,reminders:{useDefault:false}}),
    patch:(id,event,etag) => call(path(id),'PATCH',event,etag),
    remove:(id,etag) => call(path(id),'DELETE',undefined,etag)
  };
}
