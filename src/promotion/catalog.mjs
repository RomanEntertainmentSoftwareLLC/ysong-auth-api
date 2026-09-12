export const PROMOTION_PLATFORM_CATALOG = [
  ["spotify","Spotify"],["apple_music","Apple Music"],["youtube_music","YouTube Music"],["youtube","YouTube"],["amazon_music","Amazon Music"],["tidal","TIDAL"],["deezer","Deezer"],["soundcloud","SoundCloud"],["bandcamp","Bandcamp"],["pandora","Pandora"],["qobuz","Qobuz"],["audiomack","Audiomack"],["iheart","iHeartRadio"],["napster","Napster"],["boomplay","Boomplay"],["anghami","Anghami"],["joox","JOOX"],["flo","FLO"],["melon","Melon"],["genie","Genie"],["bugs","Bugs!"],["kkbox","KKBOX"],["line_music","LINE MUSIC"],["awa","AWA"],["qq_music","QQ Music"],["kugou","Kugou"],["kuwo","Kuwo"],["netease","NetEase Cloud Music"],["bilibili","Bilibili"],["rumble","Rumble"],["bitchute","BitChute"],["tiktok","TikTok"],["instagram","Instagram"],["facebook","Facebook"],["ysong","YSong"],["website","Artist Website"],["custom","Custom Link"],
].map(([id,label])=>({id,label}));

export const COUNTRY_TIERS = {
  tier1: ["US","CA","GB","IE","AU","NZ","DE","AT","CH","FR","BE","NL","DK","SE","NO","FI","IS","LU","SG","JP"],
  tier2: ["ES","IT","PT","PL","CZ","SK","HU","SI","HR","EE","LV","LT","GR","CY","MT","IL","AE","KR","HK","TW","CL","UY","CR"],
  tier3: ["AR","BR","MX","CO","PE","EC","BO","PY","PA","GT","SV","HN","NI","DO","PR","ZA","IN","ID","PH","MY","TH","VN","TR","RO","BG","RS","BA","ME","MK","AL","GE","AM","AZ","KZ","UA","MA","TN","EG","KE","GH","NG"],
};


export const ALL_COUNTRY_CODES = (`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`).trim().split(/\s+/);

export const COUNTRY_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
export function describeCountries(codes=[]) { return codes.map((code)=>({code,name:COUNTRY_NAMES.of(code)||code})); }
