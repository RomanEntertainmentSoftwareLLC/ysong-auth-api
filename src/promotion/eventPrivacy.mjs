// Keep event dimensions useful for aggregate reporting without storing a browser fingerprint.
export function eventDimensions(req) {
  let referrer = '';
  try {
    const url = new URL(String(req.get('referer') || ''));
    if (url.protocol === 'http:' || url.protocol === 'https:') referrer = url.origin.slice(0, 255);
  } catch {}
  const agent = String(req.get('user-agent') || '');
  const deviceClass = !agent ? 'unknown' : /bot|crawler|spider/i.test(agent) ? 'bot'
    : /ipad|tablet|android(?!.*mobile)/i.test(agent) ? 'tablet'
    : /mobi|iphone|ipod|android/i.test(agent) ? 'mobile' : 'desktop';
  return { referrer, deviceClass, region: null };
}
