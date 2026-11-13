import * as L from './lib.js?v=33';
import { hideChatMessageRange } from '../../../chats.js';
import { setPersonaDescription } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { user_avatar } from '../../../personas.js';
import { promptManager } from '../../../openai.js';

const MODULE = 'pamyat';
const ESSENCE_KEY = 'pamyat_essence';
const ctx = () => SillyTavern.getContext();

let memory = null;
let vectors = {};
let busy = false;
let generating = false;
let snoozeUntil = 0;
let behindWarned = false;
let stopPass = false;
let passRunning = false;
let lastInjected = new Set();
let blind = { mes: -1, ids: [] };
let loadedChat = null;
const responses = [];
let macroText = '';
let macroSlot = '';

const settings = () => {
    const all = ctx().extensionSettings;
    // Один и тот же объект: новая копия при каждом чтении теряла записи.
    all[MODULE] ??= {};
    // Кто уже работал с кобольдом, на нём и остаётся. Новым он не навязывается.
    all[MODULE].vectorSource ??= all[MODULE].koboldUrl ? 'kobold' : 'none';
    delete all[MODULE].googleProxy;
    delete all[MODULE].essenceLast;
    // Раньше лимит считался как символы / 3. Токенайзер таверны на русском у Клода даёт в 1,7 раза больше: объём тот же.
    if (all[MODULE].memoryLimit === 8000 && !all[MODULE].limitByTavern) all[MODULE].memoryLimit = 14000;
    all[MODULE].limitByTavern = true;
    for (const [key, value] of Object.entries(L.DEFAULTS)) all[MODULE][key] ??= value;
    return all[MODULE];
};

const toast = (text, kind = 'info') => globalThis.toastr?.[kind]?.(text, 'Память');
// Висит, пока идёт запрос: иначе не видно, что что-то происходит.
let progressToast = null;
let progressText = '';
function showProgress(text) {
    hideProgress();
    progressText = text;
    progressToast = globalThis.toastr?.info(text, 'Память', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: false });
}
function hideProgress() {
    if (progressToast) globalThis.toastr?.clear(progressToast, { force: true });
    progressToast = null;
}
// Пока открыто окно, запрос не идёт: статус убирается и возвращается только при повторе.
async function withoutProgress(dialog) {
    const text = progressToast ? progressText : '';
    hideProgress();
    const again = await dialog();
    if (again && text) showProgress(text);
    return again;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Файлы ----------

const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
};

async function writeFile(name, data) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ name, data: toBase64(JSON.stringify(data)) }),
    });
    if (!res.ok) throw new Error(`Файл не сохранён: ${res.status}`);
}

async function readFile(name) {
    const res = await fetch(`/user/files/${name}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Файл не прочитан: ${res.status}`);
    return res.json();
}

const memoryFile = (id) => `pamyat_${id}.json`;
const vectorFile = (id) => `pamyat_${id}_vec.json`;
async function saveMemory() {
    if (!memory) return;
    await ensureLink();
    await writeFile(memoryFile(memory.id), memory);
}
async function saveVectors() {
    if (!memory) return;
    await ensureLink();
    await writeFile(vectorFile(memory.id), vectors);
}

// ---------- Чат и герои ----------

const chatName = () => ctx().getCurrentChatId() ?? null;

function heroes() {
    const c = ctx();
    const list = [];
    if (c.groupId) {
        const group = c.groups.find((g) => g.id === c.groupId);
        for (const avatar of group?.members ?? []) {
            const ch = c.characters.find((x) => x.avatar === avatar);
            if (ch) list.push({ kind: 'character', name: ch.name, avatar: ch.avatar, description: ch.data?.description ?? ch.description ?? '' });
        }
    } else if (c.characterId !== undefined && c.characters[c.characterId]) {
        const ch = c.characters[c.characterId];
        list.push({ kind: 'character', name: ch.name, avatar: ch.avatar, description: ch.data?.description ?? ch.description ?? '' });
    }
    if (c.name1) list.push({ kind: 'persona', name: c.name1, avatar: user_avatar, description: power_user.persona_descriptions?.[user_avatar]?.description ?? power_user.persona_description ?? '' });
    return list;
}

// Векторы большие, на телефоне идут долго: панель их не ждёт, всё остальное ждёт.
let vectorsLoading = null;

async function ensureMemory() {
    await loadMemory();
    await vectorsLoading;
}

async function loadMemory() {
    const c = ctx();
    const name = chatName();
    if (!name) {
        memory = null;
        vectors = {};
        loadedChat = null;
        return;
    }
    if (loadedChat === name && memory) return;
    const meta = c.chatMetadata;
    let link = meta.pamyat;
    if (link && link.chat !== name) {
        if (meta.main_chat === link.chat) {
            // Ветка: своя копия памяти на момент создания.
            const parent = await readFile(memoryFile(link.id));
            const parentVec = await readFile(vectorFile(link.id));
            const id = c.uuidv4 ? c.uuidv4() : crypto.randomUUID();
            if (parent) {
                parent.id = id;
                parent.chat = name;
                parent.inFlight = null;
                await writeFile(memoryFile(id), parent);
            }
            if (parentVec) await writeFile(vectorFile(id), parentVec);
            link = { id, chat: name };
        } else {
            link = { id: link.id, chat: name };
        }
        meta.pamyat = link;
        await c.saveMetadata();
    }
    if (!link) {
        memory = L.emptyMemory('');
        vectors = {};
        loadedChat = name;
        memory.chat = name;
        return;
    }
    memory = Object.assign(L.emptyMemory(link.id), await readFile(memoryFile(link.id)));
    L.cleanCardKeys(memory);
    memory.chat = name;
    vectors = {};
    loadedChat = name;
    vectorsLoading = readFile(vectorFile(link.id))
        .then((v) => {
            if (loadedChat !== name) return;
            vectors = v ?? {};
            if (settings().vectorSource === 'kobold' && Object.values(vectors).some((x) => x.v)) vectorizeNew();
        })
        .catch((e) => toast(e.message, 'error'))
        .finally(() => { if (loadedChat === name) vectorsLoading = null; });
}

// Привязка создаётся только при первой записи, чтобы чаты без памяти оставались нетронутыми.
async function ensureLink() {
    if (memory.id) return;
    const c = ctx();
    memory.id = crypto.randomUUID?.() ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
    c.chatMetadata.pamyat = { id: memory.id, chat: chatName() };
    await c.saveMetadata();
}

const processed = () => (memory ? L.processedCount(ctx().chat, memory.processed) : 0);

// ---------- Скрытие ----------

async function hideProcessed() {
    if (!memory || generating) return;
    const chat = ctx().chat;
    const end = Math.min(processed(), chat.length - settings().keepLast) - 1;
    if (end < 0) return;
    let start = -1;
    let last = -1;
    for (let i = 0; i <= end; i++) {
        if (!chat[i].is_system) {
            if (start < 0) start = i;
            last = i;
        }
    }
    if (start < 0) return;
    await hideChatMessageRange(start, last, false);
    memory.hiddenRanges.push([chat[start].send_date ?? '', chat[last].send_date ?? '']);
    await saveMemory();
}

// ---------- Откат ----------

let points = null;
let pointsOf = null;
const pointsFile = (id) => `pamyat_${id}_points.json`;

async function loadPoints() {
    if (pointsOf !== memory.id) {
        points = (await readFile(pointsFile(memory.id))) ?? L.emptyPoints();
        pointsOf = memory.id;
    }
    return points;
}
const savePoints = () => writeFile(pointsFile(memory.id), points);

// Первая точка: то, что было до отслеживания.
async function seedPoints() {
    await loadPoints();
    if (!points.points.length && memory.processed) {
        L.addPoint(points, memory);
        await savePoints();
    }
    return points;
}

async function rollBack(i) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const target = points.points[i];
    const r = await new Popup(`Откатить до #${target.state.processed?.idx ?? 0}?`, POPUP_TYPE.CONFIRM, '', { okButton: 'Откатить', cancelButton: 'Не надо' }).show();
    if (r !== POPUP_RESULT.AFFIRMATIVE) return;
    await unhideOurs();
    memory = L.rollTo(points, memory, i);
    await saveMemory();
    await savePoints();
    await hideProcessed();
    await vectorizeNew().catch((e) => console.warn('[Память] векторы', e));
    renderPanel();
}

async function renderPoints() {
    const box = document.querySelector('#pamyat_points');
    if (!box) return;
    if (!memory) { box.innerHTML = ''; return; }
    const owner = memory.id;
    await seedPoints();
    if (!memory || memory.id !== owner) return;
    box.innerHTML = '';
    points.points.map((p, i) => [p, i]).reverse().forEach(([p, i]) => {
        const row = document.createElement('div');
        row.className = `pamyat-point${i === points.at ? ' pamyat-point-now' : ''}`;
        row.innerHTML = `<span>#${esc(p.state.processed?.idx ?? 0)} · ${p.label ? `${esc(p.label)} · ` : ''}${esc(p.head)}</span>`;
        if (i !== points.at) {
            const go = document.createElement('div');
            go.className = 'menu_button';
            go.textContent = i < points.at ? 'Откатить' : 'Вернуть';
            go.addEventListener('click', () => withBusy(() => rollBack(i)));
            row.append(go);
        }
        box.append(row);
    });
}

async function unhideOurs() {
    const chat = ctx().chat;
    for (const [a, b] of memory.hiddenRanges) {
        const from = chat.findIndex((m) => String(m.send_date ?? '') === String(a));
        const to = chat.findIndex((m) => String(m.send_date ?? '') === String(b));
        if (from >= 0 && to >= from) await hideChatMessageRange(from, to, true);
    }
    memory.hiddenRanges = [];
    await saveMemory();
}

// ---------- Запрос ----------

function askRequest(text, offerSkip) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const popup = new Popup(esc(text), POPUP_TYPE.CONFIRM, '', {
        okButton: 'Ок',
        cancelButton: 'Позже',
        customInputs: offerSkip ? [{ id: 'pamyat_skip', label: 'Дальше без вопросов', type: 'checkbox', defaultState: false }] : null,
    });
    return popup.show().then((r) => ({ ok: r === POPUP_RESULT.AFFIRMATIVE, skip: Boolean(popup.inputResults?.get('pamyat_skip')) }));
}

async function hungDialog() {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const r = await new Popup('Запрос завис', POPUP_TYPE.CONFIRM, '', { okButton: 'Повторить', cancelButton: 'Отложить' }).show();
    return r === POPUP_RESULT.AFFIRMATIVE;
}

// Запрос не прошёл: причина в окне, повтор только по кнопке. «Позже» оставляет готовую первую часть пачки.
async function failDialog(reason) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const r = await new Popup(esc(reason), POPUP_TYPE.CONFIRM, '', { okButton: 'Повторить', cancelButton: 'Позже' }).show();
    return r === POPUP_RESULT.AFFIRMATIVE;
}

// Последние ответы модели как есть: чтобы проверить проход по файлу.
async function logResponse(prompt, text) {
    try {
        await ensureLink();
        responses.push({ at: new Date().toISOString(), system: prompt.system.slice(0, 80), sent: prompt.user.length + prompt.system.length, text });
        await writeFile(`pamyat_${memory.id}_log.json`, responses.slice(-30));
    } catch (e) {
        console.warn('[Память] журнал', e);
    }
}

// Телефон усыпляет свёрнутую страницу и рвёт её соединения, сервер таверны при этом отменяет запрос.
let awayAt = 0;
document.addEventListener('visibilitychange', () => { if (document.hidden) awayAt = Date.now(); });

// Один запрос. Без своих повторов: при зависании и при обрыве решает пользовательница.
async function send(prompt) {
    const c = ctx();
    const ms = settings().timeoutMin * 60000;
    const profile = settings().profile;
    // Описания героев в запросе тоже с {{char}} и {{user}}.
    const system = L.fillNames(prompt.system, c.name2, c.name1);
    const user = L.fillNames(prompt.user, c.name2, c.name1);
    for (;;) {
        const started = Date.now();
        let timer;
        const abort = new AbortController();
        const hang = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('hang')), ms); });
        const request = profile
            ? c.ConnectionManagerRequestService.sendRequest(
                profile,
                [{ role: 'system', content: system }, { role: 'user', content: user }],
                settings().maxTokens,
                { includePreset: false, includeInstruct: false, extractData: true, signal: abort.signal },
                {
                    ...(settings().model ? { model: settings().model } : {}),
                    ...(settings().secrets?.[profile] ? { secret_id: settings().secrets[profile] } : {}),
                },
            ).then((r) => r?.content ?? '')
            // Без generateRaw: его обработка режет ответ на именах-стоп-строках («{{user}}:»).
            : c.generateRawData({ prompt: user, systemPrompt: system }).then((data) => c.extractMessageFromData(data));
        try {
            const text = await Promise.race([request, hang]);
            clearTimeout(timer);
            await logResponse(prompt, text);
            return text;
        } catch (e) {
            clearTimeout(timer);
            if (e.message !== 'hang') {
                const away = document.hidden || awayAt >= started;
                console.error('[Память]', e);
                const reason = [e.message, e.cause?.message, away && 'страница была свёрнута', new Date().toLocaleTimeString('ru')].filter(Boolean).join('; ');
                if (!(await withoutProgress(() => failDialog(reason)))) return null;
                continue;
            }
            request.catch(() => {});
            if (profile) abort.abort();
            else await c.eventSource.emit(c.eventTypes.GENERATION_STOPPED);
            if (!(await withoutProgress(hungDialog))) return null;
        }
    }
}

// Оборванный ответ не повторяется: пришедшее остаётся, запрашивается только остальное, в том числе конец начатой части.
async function sendWhole(prompt, onContinue) {
    let got = '';
    for (let i = 0; i < 4; i++) {
        if (i) onContinue(i);
        const text = await send(got ? L.promptContinue(prompt, got) : prompt);
        if (text === null) return null;
        if (!String(text ?? '').trim()) break;
        got = got ? L.joinCut(got, text) : text;
        if (L.isComplete(got)) return got;
    }
    return '';
}

// ---------- Векторы ----------

// Всё хранится и ищется на сервере таверны, браузер получает только найденное: телефону файл векторов не нужен.
const vectorKey = () => {
    const s = settings();
    if (s.vectorSource === 'ollama') return `ollama:${s.ollamaModel}`;
    if (s.vectorSource === 'google') return `google:${s.googleModel}`;
    return s.vectorSource === 'kobold' ? 'kobold:store' : s.vectorSource;
};

function storeBody() {
    const s = settings();
    if (s.vectorSource === 'kobold') return { source: 'koboldcpp', model: 'kobold' };
    return s.vectorSource === 'ollama'
        ? { source: 'ollama', apiUrl: s.ollamaUrl, model: s.ollamaModel, keep: false }
        : { source: 'palm', model: s.googleModel, api: 'makersuite' };
}

async function vectorStore(route, body, timeout = 120000) {
    const res = await fetch(`/api/vector/${route}`, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ ...storeBody(), ...body }),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Векторы: ${res.status}`);
    return route === 'query' ? res.json() : null;
}

const cardCollection = () => `pamyat_${memory.id}_c`;
const archiveCollection = () => `pamyat_${memory.id}_a`;

// Через сервер таверны: адрес считается от мака, поэтому работает и с телефона.
async function embed(texts, { server = settings().koboldUrl, timeout = 120000 } = {}) {
    const res = await fetch('/api/backends/kobold/embed', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify({ items: texts, server }),
        signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Кобольд: ${res.status}`);
    const data = await res.json();
    return data.embeddings;
}

async function vectorizeNew() {
    if (settings().vectorSource === 'none') return true;
    const pieces = L.searchPieces(memory).map((p) => ({ id: p.id, text: `${p.head}. ${p.keys?.length ? `${p.keys.join(', ')}. ` : ''}${p.text}`, kind: 'a' }));
    const all = [
        ...pieces,
        ...memory.cards.map((c) => ({ id: c.id, text: `${c.name}. ${c.text}`, kind: 'c' })),
    ].map((x) => ({ ...x, h: L.hash(x.text) }));
    const key = vectorKey();
    const same = (v) => (v?.s ?? 'kobold') === key;
    const fresh = new Map(all.map((x) => [x.id, x]));
    const items = all.filter((x) => vectors[x.id]?.h !== x.h || !same(vectors[x.id]));
    const stale = Object.entries(vectors).filter(([id, v]) => same(v) && fresh.get(id)?.h !== v.h);
    for (const id of Object.keys(vectors)) if (!fresh.has(id)) delete vectors[id];
    if (!items.length && !stale.length) return true;
    try {
        for (const kind of ['a', 'c']) {
            const collectionId = kind === 'a' ? archiveCollection() : cardCollection();
            const gone = stale.filter(([id]) => (id[0] === 'c' && !id.includes('~') ? 'c' : 'a') === kind).map(([, v]) => L.numericHash(v.h));
            if (gone.length) await vectorStore('delete', { collectionId, hashes: gone });
        }
        // Абзацев много: пачками быстрее, чем по одному.
        for (let i = 0; i < items.length; i += 32) {
            const part = items.slice(i, i + 32);
            for (const kind of ['a', 'c']) {
                const rows = part.filter((x) => x.kind === kind);
                if (!rows.length) continue;
                const body = { collectionId: kind === 'a' ? archiveCollection() : cardCollection(), items: rows.map((x, n) => ({ hash: L.numericHash(x.h), text: x.text, index: n })) };
                if (settings().vectorSource === 'kobold') {
                    // Векторы из старого файла переезжают как есть, кобольд считает только новое.
                    const need = rows.filter((x) => !(vectors[x.id]?.h === x.h && vectors[x.id]?.v));
                    const found = need.length ? await embed(need.map((x) => x.text)) : [];
                    body.embeddings = Object.fromEntries(rows.map((x) => [x.text, need.includes(x) ? found[need.indexOf(x)] : vectors[x.id].v]));
                }
                await vectorStore('insert', body);
                rows.forEach((item) => { vectors[item.id] = { h: item.h, s: key }; });
            }
        }
        await saveVectors();
        return true;
    } catch (e) {
        console.warn('[Память] векторы', e);
        return false;
    }
}

// ---------- Обработка пачки ----------

function heroNames() {
    return heroes().map((h) => h.name);
}

function splitInHalf(from, to) {
    return from + Math.max(1, Math.floor((to - from) / 2));
}

// Возвращает 'done' | 'later' | 'split' | 'error'. Состояние пишется в файл после каждого запроса.
async function processRange(from, to, opts) {
    const chat = ctx().chat;
    const messages = L.batchMessages(chat, from, to);
    await ensureLink();
    if (!messages.length) {
        memory.processed = L.anchorOf(chat[to - 1], to - 1);
        await saveMemory();
        return 'done';
    }
    const flight = memory.inFlight?.from === from && memory.inFlight?.to === to ? memory.inFlight : { from, to, one: null };
    const label = `${from}–${to - 1}`;
    const owner = chatName();

    const ask = async (part) => {
        if (opts.silent?.value) return true;
        const answer = await askRequest(`Сейчас будет запрос: обработка сообщений ${label} (${part} из 2)`, Boolean(opts.silent));
        if (answer.ok && answer.skip && opts.silent) opts.silent.value = true;
        return answer.ok;
    };

    const ask2 = async (prompt, part) => {
        if (!(await ask(part))) return { later: true };
        showProgress(`${label}: запрос ${part} из 2`);
        let text;
        try {
            text = await sendWhole(prompt, (n) => showProgress(`${label}: запрос ${part} из 2, продолжение ${n}`));
        } finally {
            hideProgress();
        }
        if (text === null) return { later: true };
        // Пока шёл запрос, чат сменили: ответ не должен попасть в чужую память.
        if (chatName() !== owner) return { later: true };
        if (!L.isComplete(text)) return { cut: true };
        return { text };
    };

    if (!flight.one) {
        const r = await ask2(L.promptPartOne(memory, messages, heroNames(), heroes()), 1);
        if (r.later) return 'later';
        if (r.cut) return 'split';
        flight.one = L.parsePartOne(r.text);
        memory.inFlight = flight;
        await saveMemory();
    }
    const r = await ask2(L.promptPartTwo(memory, messages, heroes()), 2);
    if (r.later) return 'later';
    if (r.cut) return 'split';
    const two = L.parsePartTwo(r.text);
    const seeded = await seedPoints();
    const summary = L.applyResult(memory, flight.one, two, { from, to, heroes: heroNames(), settings: settings() });
    memory.processed = L.anchorOf(chat[to - 1], to - 1);
    memory.inFlight = null;
    await saveMemory();
    L.addPoint(seeded, memory);
    await savePoints();
    toast(`${label}: готово`, 'success');
    opts.onDone?.(summary);
    return 'done';
}

async function cutDialog() {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const r = await new Popup('Ответ обрезан', POPUP_TYPE.CONFIRM, '', { okButton: 'Разбить', cancelButton: 'Отложить' }).show();
    return r === POPUP_RESULT.AFFIRMATIVE;
}

async function runBatch(size, opts = {}) {
    let from = processed();
    let to = L.resumeEnd(memory.inFlight, from, Math.min(from + size, ctx().chat.length));
    while (from < to) {
        const result = await processRange(from, to, opts);
        if (result !== 'split') return result;
        // «Отложить» оставляет готовую первую часть: тот же кусок продолжится со второй.
        if (to - from <= 1 || !(await cutDialog())) return 'later';
        memory.inFlight = null;
        to = splitInHalf(from, to);
    }
    return 'done';
}

async function withBusy(fn) {
    if (busy) return;
    busy = true;
    renderStatus();
    try {
        return await fn();
    } catch (e) {
        console.error('[Память]', e);
        toast(e.message, 'error');
    } finally {
        busy = false;
        renderStatus();
    }
}

function summaryHtml(s) {
    const lines = [];
    if (s.sections.length) lines.push(`Разделы: ${s.sections.map((k) => L.SECTIONS.find(([x]) => x === k)?.[2] ?? k).join(', ')}`);
    if (s.cardsNew.length) lines.push(`Новые карточки: ${s.cardsNew.join(', ')}`);
    if (s.cardsUpdated.length) lines.push(`Обновлены: ${s.cardsUpdated.join(', ')}`);
    if (s.proposed.length) lines.push(`Правки на подтверждение: ${s.proposed.join(', ')}`);
    if (s.notApplied?.length) lines.push(`Не применено: ${s.notApplied.join('; ')}`);
    if (s.longer?.length) lines.push(`Не сжато: ${s.longer.map((k) => L.SECTIONS.find(([x]) => x === k)?.[2] ?? k).join(', ')}`);
    if (s.essence?.length) lines.push(`Суть: ${s.essence.join(', ')}`);
    if (s.archive) lines.push(`Архив: +${s.archive}`);
    if (s.promoted.length) lines.push(`В постоянное: ${s.promoted.join('; ')}`);
    return lines.map((l) => `<div>${esc(l)}</div>`).join('');
}

// Окно итога с вопросами: каждый вопрос можно закрыть или оставить висеть в «Проверке».
async function resultDialog(summary) {
    const { Popup, POPUP_TYPE } = ctx();
    const root = document.createElement('div');
    root.className = 'pamyat-summary';
    root.innerHTML = summaryHtml(summary);
    const box = document.createElement('div');
    root.append(box);
    renderQuestions(box);
    const review = settings().review && summary.changes ? reviewItems(root, summary.changes) : [];
    // Enter в правке переводит строку, а не закрывает окно.
    root.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
    await new Popup(root, POPUP_TYPE.TEXT, '', { okButton: 'Ок', wide: review.length > 0, allowVerticalScrolling: true }).show();
    for (const read of review) read();
    if (review.length && L.applyReview(memory, summary.changes)) {
        await saveMemory();
        L.refreshPoint(await seedPoints(), memory);
        await savePoints();
        await vectorizeNew();
        renderPanel();
    }
}

// Текст с выделенными изменениями и правкой на месте. Стили прямо здесь: файл стилей телефон может держать в кэше.
function reviewItems(root, changes) {
    const reads = [];
    const add = (title, item) => {
        const head = document.createElement('h4');
        head.textContent = title;
        const edit = document.createElement('div');
        edit.className = 'pamyat-edit';
        edit.style.cssText = 'white-space:pre-wrap;text-align:left;padding:6px;margin-bottom:8px;border:1px solid var(--SmartThemeBorderColor,#555);border-radius:6px;';
        edit.setAttribute('contenteditable', 'plaintext-only');
        for (const part of L.diffWords(item.before, item.after)) {
            if (part.t === 'same') { edit.append(part.s); continue; }
            const span = document.createElement('span');
            span.textContent = part.s;
            span.className = part.t === 'add' ? 'pamyat-add' : 'pamyat-del';
            if (part.t === 'add') span.style.background = 'rgba(60,180,75,.4)';
            else {
                span.style.cssText = 'text-decoration:line-through;color:#e66;opacity:.75;';
                span.setAttribute('contenteditable', 'false');
            }
            edit.append(span);
        }
        // Тап по зачёркнутому: курсор сразу за ним, иначе правка не начнётся.
        edit.addEventListener('click', (e) => {
            if (!e.target.classList?.contains('pamyat-del')) return;
            edit.focus();
            const range = document.createRange();
            range.setStartAfter(e.target);
            range.collapse(true);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });
        root.append(head, edit);
        reads.push(() => {
            const copy = edit.cloneNode(true);
            copy.querySelectorAll('.pamyat-del').forEach((x) => x.remove());
            const text = copy.textContent.replace(/\u00a0/g, ' ').trim();
            if (text !== item.after.trim()) item.edited = text;
        });
    };
    changes.sections.forEach((x) => add(x.label, x));
    changes.cards.forEach((x) => add(x.name, x));
    changes.archive.forEach((x) => add(x.head, x));
    return reads;
}

async function afterBatch(summary) {
    await vectorizeNew();
    await hideProcessed();
    renderPanel();
    for (const s of [summary].flat()) if (s) await resultDialog(s);
    if (memory.arcHint) await offerArc(memory.arcHint);
}

async function maybeAuto() {
    if (!settings().enabled || busy || generating || passRunning) return;
    await ensureMemory();
    if (!memory) return;
    const chat = ctx().chat;
    await hideProcessed();
    // За время ожидания могли отправить сообщение: окно посреди ответа ломает ход.
    if (!settings().batchGame || generating) return;
    const fresh = L.autoEnd(chat) - processed();
    if (fresh < settings().batchGame || chat.length < snoozeUntil) return;
    // Незаконченный проход продолжается кнопкой, а не окном посреди игры.
    if (L.isBehind(L.autoEnd(chat), processed(), settings())) {
        if (memory.id && !behindWarned) {
            behindWarned = true;
            toast(`Не обработано: ${chat.length - processed()}`, 'warning');
        }
        return;
    }
    // Старые чаты без памяти не трогаем: для них есть «Пройти чат».
    if (!memory.id && chat.length > settings().batchGame + 5) return;
    await withBusy(async () => {
        let summary = null;
        const result = await runBatch(settings().batchGame, { onDone: (s) => { summary = s; } });
        if (result === 'later') {
            snoozeUntil = chat.length + 5;
            return;
        }
        await afterBatch(summary);
    });
}

async function processNow(limit = Infinity) {
    if (generating) return toast('Идёт ответ', 'warning');
    let longRun = false;
    await withBusy(async () => {
        await ensureMemory();
        if (!memory) return;
        if (processed() >= ctx().chat.length) return toast('Всё обработано');
        let summary = null;
        // Всё с последней обработки. Длинный кусок идёт несколькими пачками, как проход.
        const fresh = Math.min(limit, ctx().chat.length - processed());
        if (fresh > Math.max(settings().batchGame, settings().batchPass)) return void (longRun = true);
        const r = await runBatch(fresh, { onDone: (s) => { summary = s; } });
        if (r === 'done') await afterBatch(summary);
    });
    if (longRun) await runPass();
}

// Кусок до выбранного сообщения идёт одной пачкой, без нарезки. Разбить может только окно обрезанного ответа.
async function processTo(end, opts = {}) {
    if (generating) return toast('Идёт ответ', 'warning');
    await withBusy(async () => {
        await ensureMemory();
        if (!memory) return;
        const owner = chatName();
        const start = processed();
        if (start >= end) return toast('Всё обработано');
        const summaries = [];
        while (processed() < end && chatName() === owner) {
            const before = processed();
            const r = await runBatch(end - before, { ...opts, onDone: (x) => { summaries.push(x); } });
            if (r !== 'done' || processed() === before) break;
        }
        if (processed() > start) await afterBatch(summaries);
    });
}

// ---------- Выбор конца эпизода ----------

// Начало всегда первое необработанное: память идёт по чату подряд.
let picking = null;

function renderPick() {
    const from = processed();
    document.querySelectorAll('#chat .mes').forEach((el) => {
        const id = Number(el.getAttribute('mesid'));
        const on = id >= from && id <= picking.end;
        el.classList.toggle('pamyat-pick', on);
        // Прямо на сообщении: темы перекрывают фон .mes, а файл стилей телефон может держать в кэше.
        if (on) el.style.setProperty('background', 'rgba(229, 165, 10, .22)', 'important');
        else el.style.removeProperty('background');
    });
    picking.bar.querySelector('span').textContent = `${from}–${picking.end} · ${picking.end - from + 1}`;
}

function onPickTap(e) {
    const mes = e.target.closest?.('.mes');
    if (!mes) return;
    e.preventDefault();
    e.stopPropagation();
    const id = Number(mes.getAttribute('mesid'));
    if (id < processed()) return;
    picking.end = id;
    renderPick();
}

function endPick() {
    if (!picking) return;
    document.querySelector('#chat')?.removeEventListener('click', onPickTap, true);
    document.querySelectorAll('.pamyat-pick').forEach((el) => { el.classList.remove('pamyat-pick'); el.style.removeProperty('background'); });
    picking.bar.remove();
    picking = null;
}

async function startPick() {
    if (generating) return toast('Идёт ответ', 'warning');
    if (busy || picking) return;
    await ensureMemory();
    if (!memory) return;
    const chat = ctx().chat;
    if (processed() >= chat.length) return toast('Всё обработано');
    if (document.querySelector('#rm_extensions_block.openDrawer')) document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
    const bar = document.createElement('div');
    bar.className = 'pamyat-pickbar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--SmartThemeBlurTintColor,#222);';
    bar.innerHTML = '<span style="flex:1"></span><div class="menu_button" data-a="go">Обработать</div><div class="menu_button" data-a="no">Отмена</div>';
    bar.querySelector('[data-a="no"]').addEventListener('click', endPick);
    bar.querySelector('[data-a="go"]').addEventListener('click', () => {
        const end = picking.end + 1;
        endPick();
        processTo(end, { silent: { value: true } });
    });
    // Над полем ввода: position: fixed на body в таверне уводит полосу за край экрана.
    document.querySelector('#form_sheld').prepend(bar);
    picking = { bar, end: Math.max(L.autoEnd(chat) - 1, processed()) };
    document.querySelector('#chat').addEventListener('click', onPickTap, true);
    renderPick();
    document.querySelector(`#chat .mes[mesid="${picking.end}"]`)?.scrollIntoView({ block: 'center' });
}

async function runPass(limit = Infinity) {
    if (generating) return toast('Идёт ответ', 'warning');
    await withBusy(async () => {
        await ensureMemory();
        if (!memory) return;
        stopPass = false;
        passRunning = true;
        const silent = { value: false };
        let totals = 0;
        try {
            let done = 0;
            const owner = chatName();
            while (!stopPass && done < limit && chatName() === owner && processed() < ctx().chat.length) {
                done++;
                const before = processed();
                const r = await runBatch(settings().batchPass, { silent, onDone: () => { totals++; } });
                renderPanel();
                if (r !== 'done' || processed() === before) break;
                await vectorizeNew();
                await hideProcessed();
            }
        } finally {
            passRunning = false;
        }
        renderPanel();
        memory.arcHint = null;
        memory.arcEnd = null;
        await saveMemory();
        toast(processed() >= ctx().chat.length ? 'Проход завершён' : 'Проход остановлен', processed() >= ctx().chat.length ? 'success' : 'info');
        if (memory.questions.length) toast(`Вопросов: ${memory.questions.length}`);
    });
}

// ---------- Арка и описания героев ----------

async function offerArc(name) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const r = await new Popup(esc(`Арка «${name}», похоже, закончилась. Сжать?`), POPUP_TYPE.CONFIRM, '', { okButton: 'Да', cancelButton: 'Нет' }).show();
    memory.arcHint = null;
    await saveMemory();
    if (r === POPUP_RESULT.AFFIRMATIVE) await closeArc();
}

async function closeArc() {
    const answer = await askRequest('Сейчас будет запрос: закрытие арки', false);
    if (!answer.ok) return;
    const owner = chatName();
    showProgress('Запрос: арка');
    let text;
    try {
        text = await sendWhole(L.arcPrompt(memory, { arcEnd: memory.arcEnd }), (n) => showProgress(`Запрос: арка, продолжение ${n}`));
    } finally {
        hideProgress();
    }
    if (text === null || chatName() !== owner) return;
    if (!L.isComplete(text)) return toast('Ответ обрезан', 'error');
    // Своя точка: прежняя остаётся несжатой, к ней можно откатиться.
    const seeded = await seedPoints();
    const summary = L.applyArc(memory, L.parsePartOne(text), { to: processed() });
    memory.arcEnd = null;
    await saveMemory();
    L.addPoint(seeded, memory);
    seeded.points.at(-1).label = 'Арка';
    await savePoints();
    await vectorizeNew();
    renderPanel();
    await resultDialog(summary);
}

// Только по кнопке. Запись в анкету только после «Применить», старая остаётся снимком.
async function updateHeroes() {
    const chat = ctx().chat;
    if (L.isBehind(chat.length, processed(), settings())) return toast('Сначала пройти чат', 'warning');
    const list = heroes();
    const tail = L.batchMessages(chat, processed(), chat.length);
    const since = L.archiveSince(memory, list);
    let brief = false;
    if (L.archiveLength(since) > L.BIG_ARCHIVE) {
        const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
        const r = await new Popup(esc(`Архив с прошлого обновления: ${Math.round(L.archiveLength(since) / 1000)} тыс. знаков`), POPUP_TYPE.CONFIRM, '', { okButton: 'Кратко', cancelButton: 'Полностью' }).show();
        brief = r === POPUP_RESULT.AFFIRMATIVE;
    }
    const chunks = brief ? [L.briefArchive(since)] : L.archiveChunks(since);
    const owner = chatName();
    // Черновик передаётся от части к части: каждый следующий запрос дополняет предыдущий.
    const drafts = list.map((h) => ({ ...h }));
    let parsed = null;
    const failed = {};
    const labels = {};
    for (let i = 0; i < chunks.length; i++) {
        const label = chunks.length > 1 ? ` (${i + 1} из ${chunks.length})` : '';
        const answer = await askRequest(`Сейчас будет запрос: обновление героев${label}`, false);
        if (!answer.ok) return;
        showProgress(`Запрос: герои${label}`);
        let text;
        try {
            text = await sendWhole(L.heroPrompt(memory, drafts, { tail: i === chunks.length - 1 ? tail : [], template: settings().heroTemplate, archive: chunks[i], brief }));
        } finally {
            hideProgress();
        }
        if (text === null || chatName() !== owner) return;
        if (!L.isComplete(text)) return toast('Ответ обрезан', 'error');
        parsed = L.parseArc(text);
        for (const d of parsed.descriptions) {
            const draft = drafts.find((h) => h.name === d.name);
            if (draft) draft.description = d.text;
        }
        for (const draft of drafts) {
            const applied = L.applyHeroEdits(draft.description, parsed.edits[draft.name], { char: ctx().name2, user: ctx().name1 });
            draft.description = applied.text;
            failed[draft.name] = [...(failed[draft.name] ?? []), ...applied.failed];
            if (parsed.labels[draft.name]) labels[draft.name] = parsed.labels[draft.name];
        }
    }
    for (const draft of drafts) {
        const hero = list.find((h) => h.name === draft.name);
        // Правки не легли: окно всё равно, чтобы было видно «Не применено».
        if (draft.description === hero.description && !failed[draft.name]?.length) continue;
        const fromRewrite = parsed?.descriptions?.find((d) => d.name === draft.name);
        await reviewDescription(hero, { text: draft.description, ...labels[draft.name], ...(fromRewrite ? { label: fromRewrite.label, oldLabel: fromRewrite.oldLabel } : {}) }, failed[draft.name] ?? []);
    }
}

async function writeDescription(hero, text) {
    const c = ctx();
    if (hero.kind === 'character') {
        const res = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: c.getRequestHeaders(),
            body: JSON.stringify({ avatar: hero.avatar, description: text, data: { description: text } }),
        });
        if (!res.ok) throw new Error(`Описание не сохранено: ${res.status}`);
        const ch = c.characters.find((x) => x.avatar === hero.avatar);
        if (ch) {
            ch.description = text;
            if (ch.data) ch.data.description = text;
        }
        const field = document.querySelector('#description_textarea');
        if (field && c.characters[c.characterId]?.avatar === hero.avatar) field.value = text;
    } else {
        power_user.persona_description = text;
        if (power_user.persona_descriptions?.[hero.avatar]) power_user.persona_descriptions[hero.avatar].description = text;
        const field = document.querySelector('#persona_description');
        if (field) field.value = text;
        setPersonaDescription();
        c.saveSettingsDebounced();
    }
}

async function reviewDescription(hero, proposal, failed = []) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const root = document.createElement('div');
    const bad = L.findForbidden(proposal.text);
    const limit = L.descriptionLimit(hero.description);
    const over = proposal.text.length > limit ? `${proposal.text.length} из ${limit} символов` : '';
    const lost = L.lostSentences(hero.description, proposal.text);
    const notes = [[...bad, over].filter(Boolean).join(', '), failed.length ? `Не применено: ${failed.join(' | ')}` : '', lost.length ? `Изменено предложений: ${lost.length}` : ''].filter(Boolean);
    root.innerHTML = `<h3>${esc(hero.name)}</h3>${notes.map((n) => `<div class="pamyat-warn">${esc(n)}</div>`).join('')}<div class="pamyat-compare"><div><b>Старое</b><textarea readonly class="text_pole">${esc(hero.description)}</textarea></div><div><b>Новое</b><textarea class="text_pole pamyat-new">${esc(proposal.text)}</textarea></div></div>`;
    const area = root.querySelector('.pamyat-new');
    const r = await new Popup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Применить', cancelButton: 'Не надо', allowVerticalScrolling: true, wide: true }).show();
    if (r !== POPUP_RESULT.AFFIRMATIVE) return;
    memory.snapshots.push({ id: `s${Date.now()}`, who: hero.name, avatar: hero.avatar, kind: hero.kind, label: proposal.oldLabel || memory.heroLabels?.[hero.name] || `${hero.name}, до: ${proposal.label || 'обновления'}`, text: hero.description });
    await backupHero(hero, proposal.oldLabel || 'до обновления');
    await writeDescription(hero, area.value);
    memory.heroLabels = { ...memory.heroLabels, [hero.name]: proposal.label };
    memory.heroArchiveAt = { ...memory.heroArchiveAt, [hero.name]: memory.archive.length };
    await vectorizeNew();
    await saveMemory();
    renderPanel();
}

// Бэкап анкет: свой файл на героя, не зависит от чата, памяти и сброса.
const backupFile = (hero) => `pamyat_backup_${L.hash(`${hero.kind}:${hero.avatar}`)}.json`;
const readBackups = async (hero) => (await readFile(backupFile(hero))) ?? [];

async function backupHero(hero, label) {
    const list = await readBackups(hero);
    if (list.at(-1)?.text === hero.description) return;
    list.push({ at: new Date().toISOString(), label, name: hero.name, text: hero.description });
    await writeFile(backupFile(hero), list);
}

async function restoreBackup(hero, entry) {
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await new Popup(esc(`Вернуть анкету: ${entry.label}?`), POPUP_TYPE.CONFIRM, '', { okButton: 'Вернуть', cancelButton: 'Отмена' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    // Текущая тоже сохраняется: возврат можно отменить.
    await backupHero(hero, 'до возврата');
    await writeDescription(hero, entry.text);
    toast('Анкета возвращена');
    renderPanel();
}

async function renderBackups() {
    const box = document.querySelector('#pamyat_snapshots');
    if (!box) return;
    const rows = [];
    for (const hero of memory ? heroes() : []) {
        const list = await readBackups(hero).catch(() => []);
        for (const entry of [...list].reverse()) rows.push({ hero, entry });
    }
    const worlds = new Set((memory?.cards ?? []).map((x) => x.source?.world).filter(Boolean));
    const loreRows = [];
    for (const world of worlds) loreRows.push(...[...((await readFile(loreBackupFile(world)).catch(() => null)) ?? [])].reverse());
    box.innerHTML = '';
    for (const entry of loreRows) {
        const row = document.createElement('details');
        row.className = 'pamyat-card';
        row.innerHTML = `<summary>${esc(entry.world)}: ${esc(entry.name)}</summary><div class="menu_button">Вернуть</div><div>${esc(entry.text)}</div>`;
        row.querySelector('.menu_button').addEventListener('click', () => restoreLore(entry).catch((e) => toast(e.message, 'error')));
        box.append(row);
    }
    for (const { hero, entry } of rows) {
        const row = document.createElement('details');
        row.className = 'pamyat-card';
        const when = new Date(entry.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
        row.innerHTML = `<summary>${esc(hero.name)}, ${esc(entry.label)}, ${esc(when)}</summary><div class="menu_button">Вернуть</div><div>${esc(entry.text)}</div>`;
        row.querySelector('.menu_button').addEventListener('click', () => restoreBackup(hero, entry).catch((e) => toast(e.message, 'error')));
        box.append(row);
    }
}

// ---------- Вызвано ----------

let fired = { cards: [], archive: [] };
let placeFired = () => {};

// Место значка у каждого устройства своё: на телефоне и на маке разные экраны.
const ICON_PLACE = 'pamyat_icon_place';
const readPlace = () => {
    try {
        return JSON.parse(localStorage.getItem(ICON_PLACE));
    } catch {
        return null;
    }
};
const writePlace = (place) => {
    try {
        localStorage.setItem(ICON_PLACE, JSON.stringify(place));
    } catch { /* без памяти места значок просто вернётся на своё */ }
};

function placeIcon(button, place) {
    const size = button.offsetWidth || 44;
    const x = place?.x ?? 8;
    const y = place?.y ?? innerHeight - 240;
    button.style.left = `${Math.max(0, Math.min(x, innerWidth - size))}px`;
    button.style.top = `${Math.max(0, Math.min(y, innerHeight - size))}px`;
}

function mountFired() {
    if (document.querySelector('#pamyat_fired_btn')) return;
    const button = document.createElement('div');
    button.id = 'pamyat_fired_btn';
    button.title = 'Вызвано';
    button.innerHTML = '<i class="fa-solid fa-brain"></i>';
    const box = document.createElement('div');
    box.id = 'pamyat_fired';
    box.className = 'displayNone';
    const place = () => {
        const r = button.getBoundingClientRect();
        const at = L.boxPlace(r, { w: innerWidth, h: innerHeight }, box.offsetHeight);
        box.style.left = `${at.left}px`;
        box.style.top = `${at.top}px`;
        box.style.width = `${at.width}px`;
        box.style.maxHeight = `${Math.min(at.maxHeight, innerHeight * 0.7)}px`;
    };
    placeFired = () => { if (!box.classList.contains('displayNone')) { place(); place(); } };
    let drag = null;
    let moved = false;
    button.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        const r = button.getBoundingClientRect();
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top };
        moved = false;
        try { button.setPointerCapture?.(e.pointerId); } catch { /* палец может соскочить, не страшно */ }
    });
    button.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        placeIcon(button, { x: drag.left + dx, y: drag.top + dy });
        placeFired();
    });
    const release = () => {
        if (drag && moved) writePlace({ x: parseFloat(button.style.left), y: parseFloat(button.style.top) });
        drag = null;
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('click', () => {
        if (moved) { moved = false; return; }
        box.classList.toggle('displayNone');
        placeFired();
    });
    document.addEventListener('pointerdown', (e) => {
        if (!button.contains(e.target) && !box.contains(e.target)) box.classList.add('displayNone');
    });
    document.body.append(button, box);
    placeIcon(button, readPlace());
    addEventListener('resize', () => { placeIcon(button, readPlace()); placeFired(); });
    syncIcon();
    renderFired();
}

function syncIcon() {
    const on = settings().icon !== false;
    document.querySelector('#pamyat_fired_btn')?.classList.toggle('displayNone', !on);
    if (!on) document.querySelector('#pamyat_fired')?.classList.add('displayNone');
}

function renderFired() {
    const box = document.querySelector('#pamyat_fired');
    if (!box) return;
    const total = fired.cards.length + fired.archive.length;
    document.querySelector('#pamyat_fired_btn').dataset.count = total;
    const block = (title, rows) => (rows.length ? `<h4>${title}</h4>${rows.map((r) => `<div class="pamyat-fired-row" title="${esc(r.text ?? '')}"><b>${esc(r.name)}</b>${r.phrase ? `: <span>${esc(r.phrase)}</span>` : ''}</div>`).join('')}` : '');
    const t = fired.tokens;
    box.innerHTML = total || t ? `${t ? `<div><b>${t.all}</b> токенов: база ${t.base}, карточки ${t.cards}, архив ${t.archive}, суть ${t.essence}</div>` : ''}${block('Карточки', fired.cards)}${block('Архив', fired.archive)}` : 'Пусто';
    placeFired();
}

// Фразы ищутся сбоку от запроса: ответ модели их не ждёт.
async function findPhrases(target, query) {
    const phrases = L.phrasesOf(query);
    for (const row of target.cards) row.phrase = L.phraseWithName(row.card, phrases) || (row.always ? 'всегда' : row.link);
    renderFired();
    const rows = [...target.cards, ...target.archive].filter((r) => !r.phrase);
    if (!rows.length || !phrases.length) return;
    if (settings().vectorSource !== 'kobold') {
        for (const row of rows) row.phrase = L.phraseByWords(row.text ?? '', phrases);
        renderFired();
        return;
    }
    try {
        const found = await embed([...phrases, ...rows.map((r) => r.text ?? '')], { timeout: 30000 });
        const own = found.slice(phrases.length);
        rows.forEach((row, i) => { row.phrase = L.closestPhrase(own[i], phrases, found); });
    } catch (e) {
        console.warn('[Память] фразы не найдены', e);
        for (const row of rows) row.phrase = L.phraseByWords(row.text ?? '', phrases);
    }
    if (fired === target) renderFired();
}

// Записи, отданные памяти, таверна пропускает, пока память реально вставляется. Сам лорбук не меняется.
function onLoreLoaded({ globalLore, characterLore, chatLore, personaLore }) {
    if (!settings().enabled || !memory?.id) return;
    L.dropHanded([globalLore, characterLore, chatLore, personaLore], L.handedLore(memory));
}

// ---------- Вставка в промпт ----------

function rankByWords(query) {
    const found = L.keywordRank(L.searchPieces(memory), query);
    return { archive: found.map((x) => x.p), cards: [], scores: {} };
}

async function rank(query) {
    if (settings().vectorSource === 'none') return rankByWords(query);
    try {
        const embeddings = settings().vectorSource === 'kobold' ? { [query]: (await embed([query], { timeout: 10000 }))[0] } : undefined;
        const ask = (collectionId, topK, threshold) => vectorStore('query', { collectionId, searchText: query, topK, threshold, embeddings }, 15000);
        const [a, c] = await Promise.all([ask(archiveCollection(), settings().piecesTop, 0), ask(cardCollection(), settings().cardsTop, settings().scoreMin)]);
        const byHash = (list) => new Map(list.map((x) => [L.numericHash(vectors[x.id]?.h ?? ''), x]));
        const pieces = byHash(L.searchPieces(memory));
        const known = byHash(memory.cards);
        return {
            archive: (a.hashes ?? []).map((h) => pieces.get(Number(h))).filter(Boolean),
            cards: (c.metadata ?? []).map((m) => known.get(Number(m.hash))).filter(Boolean),
            scores: {},
        };
    } catch (e) {
        console.warn('[Память] поиск недоступен', e);
        return rankByWords(query);
    }
}

// Токенайзер самой таверны: те же цифры, что в менеджере промптов.
async function countTokens(text) {
    if (!text) return 0;
    try {
        return await ctx().getTokenCountAsync(text);
    } catch (e) {
        console.warn('[Память] токенайзер', e);
        return L.tokensOf(text);
    }
}

// Считать токенайзером на каждом шаге урезания долго: поправка считается по целому тексту.
async function fitToLimit(cardList, archiveList, ranks) {
    const limit = settings().memoryLimit;
    const whole = L.buildPrompt(memory, cardList, archiveList);
    let fit = { cards: cardList, archive: archiveList };
    let real = await countTokens(whole);
    for (let i = 0; i < 3 && real > limit; i++) {
        const text = L.buildPrompt(memory, fit.cards, fit.archive);
        const ratio = (await countTokens(text)) / L.tokensOf(text);
        fit = L.fitMemory(memory, fit.cards, fit.archive, Math.floor(limit / ratio) - (i * 50), ranks);
        real = await countTokens(L.buildPrompt(memory, fit.cards, fit.archive));
    }
    return fit;
}

globalThis.pamyat_intercept = async function (chat, _size, abort, type) {
    if (type === 'quiet') return;
    if (busy && !settings().profile) {
        toast('Идёт обработка', 'warning');
        abort(true);
        return;
    }
    const c = ctx();
    fired = { cards: [], archive: [] };
    renderFired();
    const clear = () => {
        macroText = '';
        c.setExtensionPrompt(MODULE, '', 0, 0);
    };
    if (!settings().enabled) {
        c.setExtensionPrompt(ESSENCE_KEY, '', 1, 0, false, 0);
        return clear();
    }
    await ensureMemory();
    const essenceText = L.essenceBlock(memory, heroNames());
    // Сразу после чата, глубина 0: 1 это «в чате», 0 это роль system.
    c.setExtensionPrompt(ESSENCE_KEY, essenceText, 1, 0, false, 0);
    // Отставшая память тоже идёт в игру: обработанное скрыто, без неё оно пропало бы из промпта.
    if (!memory || !memory.id) return clear();
    const query = chat.slice(-3).map((m) => L.stripOoc(m.mes)).join('\n').slice(-3000);
    const { archive, cards: ranked, scores } = await rank(query);
    const extraIds = (type === 'regenerate' || type === 'swipe') ? blind.ids : [];
    const why = L.explainCards(memory, { query, ranked, extraIds, settings: settings(), scores, heroes: heroNames() });
    const fit = await fitToLimit([...why.keys()], archive.slice(0, settings().piecesTop), L.cardRanks(why, query));
    const cards = fit.cards;
    const top = fit.archive.sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
    fired.cards = cards.map((x) => ({ id: x.id, name: x.name, card: x, always: why.get(x).includes('всегда'), link: why.get(x).every((w) => w.startsWith('связь')) ? why.get(x)[0] : '', text: x.text }));
    fired.archive = top.map((a) => ({ id: a.id, name: L.entryTitle(a.text), text: a.text }));
    findPhrases(fired, query);
    lastInjected = new Set(cards.map((x) => x.id));
    const text = L.buildPrompt(memory, cards, top);
    const owner = fired;
    const base = await countTokens(L.buildPrompt(memory, [], []));
    const withCards = await countTokens(L.buildPrompt(memory, cards, []));
    const all = await countTokens(text);
    const essence = await countTokens(L.essenceBlock(memory, heroNames()));
    owner.tokens = { all: all + essence, base, cards: withCards - base, archive: all - withCards, essence };
    renderFired();
    macroSlot = currentSlot();
    if (macroSlot === 'main') {
        macroText = '';
        c.setExtensionPrompt(MODULE, text, 0, 0);
    } else {
        macroText = text;
        c.setExtensionPrompt(MODULE, '', 0, 0);
    }
};

// Включённые блоки текущего пресета. Вне чат-режима пресета нет: тогда обычная вставка.
function currentSlot() {
    try {
        if (ctx().mainApi !== 'openai' || !promptManager) return 'main';
        const prompts = promptManager.serviceSettings?.prompts ?? ctx().chatCompletionSettings?.prompts ?? [];
        const enabled = prompts.filter((p) => p.content && !promptManager.isPromptDisabledForActiveCharacter(p.identifier)).map((p) => p.content);
        return L.chooseSlot(enabled);
    } catch (e) {
        console.warn('[Память] пресет', e);
        return 'main';
    }
}

function markBlind(mesId) {
    if (!memory?.id) return;
    const message = ctx().chat[mesId];
    if (!message || message.is_user) return;
    const found = L.namedCards(memory.cards, message.mes, heroNames()).filter((x) => !lastInjected.has(x.id));
    blind = { mes: mesId, ids: found.map((x) => x.id) };
    if (!found.length) return;
    const block = document.querySelector(`.mes[mesid="${mesId}"] .mes_block`);
    if (!block) return;
    block.querySelector('.pamyat-note')?.remove();
    const note = document.createElement('div');
    note.className = 'pamyat-note';
    note.textContent = `Не было в промпте: ${found.map((x) => x.name).join(', ')}`;
    block.append(note);
}

// ---------- Панель ----------

function renderQuestions(box) {
    box.innerHTML = '';
    if (memory) memory.questions = L.uniqueQuestions(memory.questions);
    for (const q of memory?.questions ?? []) {
        const el = document.createElement('div');
        el.className = 'pamyat-question';
        el.innerHTML = `<div>${esc(q.text)}</div><div class="pamyat-q-buttons"></div>`;
        const buttons = el.querySelector('.pamyat-q-buttons');
        const add = (label, idx) => {
            const b = document.createElement('div');
            b.className = 'menu_button';
            b.textContent = label;
            b.addEventListener('click', async () => {
                L.answerQuestion(memory, q.id, idx, processed());
                await saveMemory();
                el.remove();
                renderPanel();
            });
            buttons.append(b);
        };
        q.options.forEach((o, i) => add(o.label, i));
        add('Неважно', null);
        box.append(el);
    }
}

function renderStatus() {
    const el = document.querySelector('#pamyat_status');
    if (!el) return;
    const total = ctx().chat?.length ?? 0;
    el.textContent = memory ? `${processed()} / ${total}${busy ? ' · запрос' : ''}` : '';
    document.querySelector('#pamyat_stop')?.classList.toggle('displayNone', !passRunning);
}

function renderPanel() {
    renderPoints().catch((e) => console.warn('[Память] точки', e));
    renderStatus();
    const sections = document.querySelector('#pamyat_sections');
    if (!sections) return;
    sections.innerHTML = '';
    for (const [key, , title] of L.SECTIONS) {
        const wrap = document.createElement('div');
        wrap.innerHTML = `<h4>${title}</h4><textarea class="text_pole"></textarea>`;
        const area = wrap.querySelector('textarea');
        area.value = memory?.sections[key] ?? '';
        area.addEventListener('change', async () => {
            if (!memory) return;
            await ensureLink();
            memory.sections[key] = L.cleanDash(area.value);
            await saveMemory();
        });
        sections.append(wrap);
    }
    document.querySelector('#pamyat_clar').innerHTML = (memory?.clarifications ?? []).map((c) => `<div>${esc(c.text)}</div>`).join('');
    document.querySelector('#pamyat_clar_n').textContent = memory?.clarifications?.length || '';
    document.querySelector('#pamyat_cards_n').textContent = memory?.cards?.length || '';
    document.querySelector('#pamyat_archive_n').textContent = memory?.archive?.length || '';

    renderQuestions(document.querySelector('#pamyat_questions'));
    renderEssence();
    renderCards();
    const arc = document.querySelector('#pamyat_archive');
    arc.innerHTML = (memory?.archive ?? []).map((a) => `<details><summary>${esc(a.head)}</summary><div>${esc(a.ru ?? a.text)}</div></details>`).join('');
    renderBackups().catch((e) => console.warn('[Память] бэкап', e));
}

function renderEssence() {
    const box = document.querySelector('#pamyat_essence');
    if (!box) return;
    box.innerHTML = '';
    for (const name of memory ? heroNames() : []) {
        const row = document.createElement('div');
        row.innerHTML = `<b>${esc(name)}</b><textarea class="text_pole" rows="2"></textarea>`;
        const area = row.querySelector('textarea');
        area.value = memory.essence?.[name] ?? '';
        area.addEventListener('change', async () => {
            memory.essence = { ...memory.essence, [name]: L.cleanDash(area.value) };
            await saveMemory();
        });
        box.append(row);
    }
}

function renderCards() {
    const box = document.querySelector('#pamyat_cards');
    if (!box) return;
    box.innerHTML = '';
    for (const card of memory?.cards ?? []) {
        const el = document.createElement('details');
        el.className = 'pamyat-card';
        el.innerHTML = `<summary>${esc(card.name)}</summary>
            <input class="text_pole pamyat-name" placeholder="Имя">
            <input class="text_pole pamyat-line" placeholder="Строка">
            <input class="text_pole pamyat-keys" placeholder="Ключи">
            <textarea class="text_pole pamyat-text"></textarea>
            ${card.ru ? `<details><summary>Русский</summary><div>${esc(card.ru)}</div></details>` : ''}
            <label class="checkbox_label"><input type="checkbox" class="pamyat-always"><span>Всегда</span></label>
            <label class="checkbox_label"><input type="checkbox" class="pamyat-locked"><span>Не трогать</span></label>
            ${card.proposed ? `<div class="pamyat-warn">${esc(card.proposed.text)}</div><div class="pamyat-q-buttons"><div class="menu_button pamyat-accept">Принять</div><div class="menu_button pamyat-reject">Отклонить</div></div>` : ''}
            ${card.versions?.length ? '<div class="menu_button pamyat-back">Вернуть</div>' : ''}
            <div class="menu_button pamyat-del">Удалить</div>`;
        el.querySelector('.pamyat-name').value = card.name;
        el.querySelector('.pamyat-line').value = card.line ?? '';
        el.querySelector('.pamyat-keys').value = (card.keys ?? []).join(', ');
        el.querySelector('.pamyat-text').value = card.text ?? '';
        el.querySelector('.pamyat-always').checked = Boolean(card.always);
        el.querySelector('.pamyat-locked').checked = Boolean(card.locked);
        const save = async () => {
            card.name = el.querySelector('.pamyat-name').value.trim() || card.name;
            card.line = L.cleanDash(el.querySelector('.pamyat-line').value);
            card.keys = el.querySelector('.pamyat-keys').value.split(',').map((x) => x.trim()).filter(Boolean);
            card.text = L.cleanDash(el.querySelector('.pamyat-text').value);
            card.always = el.querySelector('.pamyat-always').checked;
            card.locked = el.querySelector('.pamyat-locked').checked;
            await saveMemory();
            await vectorizeNew();
        };
        el.querySelectorAll('input, textarea').forEach((x) => x.addEventListener('change', save));
        el.querySelector('.pamyat-del').addEventListener('click', async () => {
            memory.cards.splice(memory.cards.indexOf(card), 1);
            delete vectors[card.id];
            await saveMemory();
            await saveVectors();
            renderCards();
        });
        el.querySelector('.pamyat-back')?.addEventListener('click', async () => {
            L.restoreCard(card);
            await saveMemory();
            await vectorizeNew();
            renderCards();
        });
        el.querySelector('.pamyat-accept')?.addEventListener('click', async () => {
            Object.assign(card, { text: card.proposed.text, line: card.proposed.line || card.line, proposed: null });
            await saveMemory();
            renderCards();
        });
        el.querySelector('.pamyat-reject')?.addEventListener('click', async () => {
            card.proposed = null;
            await saveMemory();
            renderCards();
        });
        box.append(el);
    }
}

async function checkVectors() {
    const out = document.querySelector('#pamyat_kobold_status');
    const source = settings().vectorSource;
    if (source !== 'kobold') {
        out.textContent = '...';
        try {
            await vectorStore('query', { collectionId: 'pamyat_check', searchText: 'проверка', topK: 1, threshold: 0 }, 30000);
            out.textContent = 'Да';
            return true;
        } catch (e) {
            out.textContent = e.message;
            return false;
        }
    }
    for (const port of [5001, 5002]) {
        const url = `http://127.0.0.1:${port}`;
        try {
            const [v] = await embed(['проверка'], { server: url, timeout: 15000 });
            if (v?.length) {
                settings().koboldUrl = url;
                document.querySelector('#pamyat_kobold').value = url;
                ctx().saveSettingsDebounced();
                out.textContent = `${port}: ${v.length}`;
                return true;
            }
        } catch { /* следующий порт */ }
    }
    out.textContent = 'Нет';
    return false;
}

async function importDialog() {
    await ensureMemory();
    if (!memory || busy) return;
    const c = ctx();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = c;
    const names = c.getWorldInfoNames();
    if (!names.length) return toast('Лорбуков нет', 'warning');
    const root = document.createElement('div');
    root.innerHTML = `<h3>Лорбук</h3><select class="text_pole" id="pamyat_world">${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select><div class="pamyat-q-buttons"><div class="menu_button" data-a="all">Выбрать всё</div><div class="menu_button" data-a="none">Снять всё</div></div><div id="pamyat_lore_list" class="pamyat-lore-list"></div>`;
    const select = root.querySelector('select');
    for (const [a, on] of [['all', true], ['none', false]]) root.querySelector(`[data-a="${a}"]`).addEventListener('click', () => root.querySelectorAll('#pamyat_lore_list input').forEach((x) => { x.checked = on; }));
    const listEntries = async () => Object.values((await c.loadWorldInfo(select.value))?.entries ?? {}).filter((e) => !e.disable && e.content);
    const fill = async () => {
        root.querySelector('#pamyat_lore_list').innerHTML = (await listEntries()).map((e) => `<label class="checkbox_label"><input type="checkbox" checked data-uid="${esc(e.uid)}"><span>${esc(e.comment || e.key?.[0] || e.uid)}</span></label>`).join('');
    };
    select.addEventListener('change', () => fill().catch((e) => toast(e.message, 'error')));
    // Сначала лорбук с именем героя, потом лорбук чата, потом лорбук самого персонажа.
    const guess = names.find((n) => heroNames().some((h) => n === h)) ?? c.chatMetadata.world_info ?? c.characters[c.characterId]?.data?.extensions?.world;
    if (guess && names.includes(guess)) select.value = guess;
    await fill();
    const result = await new Popup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Импорт', cancelButton: 'Отмена' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    // Не отмеченное остаётся только в лорбуке и работает как обычно.
    const picked = new Set([...root.querySelectorAll('#pamyat_lore_list input:checked')].map((x) => x.dataset.uid));
    const entries = (await listEntries()).filter((e) => picked.has(String(e.uid)));
    const report = L.importLore(memory, entries, heroNames(), select.value);
    await saveMemory();
    await vectorizeNew();
    renderPanel();
    toast(`Новых: ${report.added.length}, обновлено: ${report.updated.length}`, 'success');
}

// Запись в лорбук только после «Применить», прошлый текст остаётся в бэкапе.
const loreBackupFile = (world) => `pamyat_lore_${L.hash(world)}.json`;

async function syncLore() {
    const c = ctx();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = c;
    const changed = L.loreChanges(memory);
    if (!changed.length) return toast('Изменений нет');
    for (const card of changed) {
        const data = await c.loadWorldInfo(card.source.world);
        const entry = data?.entries?.[card.source.uid];
        if (!entry) continue;
        const root = document.createElement('div');
        root.innerHTML = `<h3>${esc(card.name)}</h3><div class="pamyat-compare"><div><b>Лорбук</b><textarea readonly class="text_pole">${esc(entry.content)}</textarea></div><div><b>Новое</b><textarea class="text_pole pamyat-lore-new">${esc(card.text)}</textarea></div></div>`;
        const result = await new Popup(root, POPUP_TYPE.CONFIRM, '', { okButton: 'Применить', cancelButton: 'Не надо', allowVerticalScrolling: true, wide: true }).show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) continue;
        const file = loreBackupFile(card.source.world);
        const list = (await readFile(file)) ?? [];
        list.push({ at: new Date().toISOString(), world: card.source.world, uid: card.source.uid, name: card.name, text: entry.content });
        await writeFile(file, list);
        const text = root.querySelector('.pamyat-lore-new').value;
        entry.content = text;
        await c.saveWorldInfo(card.source.world, data, true);
        c.reloadWorldInfoEditor?.(card.source.world);
        card.text = text;
        card.lore = text;
        await saveMemory();
    }
    renderPanel();
}

async function restoreLore(row) {
    const c = ctx();
    const { Popup, POPUP_TYPE, POPUP_RESULT } = c;
    const result = await new Popup(esc(`Вернуть запись лорбука: ${row.name}?`), POPUP_TYPE.CONFIRM, '', { okButton: 'Вернуть', cancelButton: 'Отмена' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    const data = await c.loadWorldInfo(row.world);
    if (!data?.entries?.[row.uid]) return toast('Записи нет', 'warning');
    data.entries[row.uid].content = row.text;
    await c.saveWorldInfo(row.world, data, true);
    c.reloadWorldInfoEditor?.(row.world);
    toast('Запись возвращена');
}

async function resetDialog() {
    await ensureMemory();
    if (!memory || busy) return;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const result = await new Popup('Сбросить память этого чата?', POPUP_TYPE.CONFIRM, '', { okButton: 'Сбросить', cancelButton: 'Отмена' }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;
    // Всё назад: скрытое расширением открывается, иначе эти сообщения пропали бы из игры вместе с памятью.
    await unhideOurs();
    for (const collectionId of [archiveCollection(), cardCollection()]) {
        await fetch('/api/vector/purge', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ collectionId }) }).catch(() => {});
    }
    memory = L.resetMemory(memory);
    vectors = {};
    await loadPoints();
    points = L.emptyPoints();
    await savePoints();
    await saveMemory();
    await saveVectors();
    await vectorizeNew();
    macroText = '';
    ctx().setExtensionPrompt(MODULE, '', 0, 0);
    ctx().setExtensionPrompt(ESSENCE_KEY, '', 1, 0, false, 0);
    renderPanel();
}

function renderProfiles() {
    const select = document.querySelector('#pamyat_profile');
    if (!select) return;
    const profiles = (ctx().extensionSettings.connectionManager?.profiles ?? []).filter((p) => p.mode !== 'tc');
    select.innerHTML = `<option value="">Текущее</option>${profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}`;
    select.value = settings().profile;
    if (select.value !== settings().profile) select.value = '';
    renderModels();
}

const currentProfile = () => (ctx().extensionSettings.connectionManager?.profiles ?? []).find((p) => p.id === settings().profile);

function renderModels(list = [], failed = false) {
    const row = document.querySelector('#pamyat_model_row');
    const select = document.querySelector('#pamyat_model');
    const manual = document.querySelector('#pamyat_model_manual');
    if (!row || !select) return;
    const profile = currentProfile();
    row.classList.toggle('displayNone', !profile);
    if (!profile) return;
    const chosen = settings().model || profile.model || '';
    const names = [...new Set([chosen, ...list].filter(Boolean))];
    select.innerHTML = names.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    select.value = chosen;
    manual.value = chosen;
    select.classList.toggle('displayNone', failed);
    manual.classList.toggle('displayNone', !failed);
}

async function requestModels(profile, source, secretId) {
    const c = ctx();
    const res = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: c.getRequestHeaders(),
        body: JSON.stringify({ chat_completion_source: source, custom_url: profile['api-url'], secret_id: secretId }),
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* не JSON */ }
    return L.modelIds(data);
}

// Рабочий ключ берётся из самой таверны: значения ключей расширение не видит, только их номера.
async function findWorkingSecret(profile) {
    const c = ctx();
    const { source } = c.ConnectionManagerRequestService.validateProfile(profile);
    if (source !== 'custom') {
        return { secret: null, list: await requestModels(profile, source, profile['secret-id']) };
    }
    const res = await fetch('/api/secrets/read', { method: 'POST', headers: c.getRequestHeaders(), body: '{}' });
    const state = res.ok ? await res.json() : {};
    for (const secret of L.secretCandidates(profile, state.api_key_custom, profile['api-url'])) {
        const list = await requestModels(profile, source, secret.id);
        if (list.length) return { secret, list };
    }
    return { secret: null, list: [] };
}

// Список всех моделей у прокси профиля: при выборе профиля, открытии панели и по кнопке.
async function loadModels() {
    const profile = currentProfile();
    const out = document.querySelector('#pamyat_models_status');
    if (!profile) return;
    out.textContent = '...';
    try {
        const { secret, list } = await findWorkingSecret(profile);
        if (!list.length) {
            out.textContent = 'Ни один ключ не подошёл';
            renderModels([], true);
            return;
        }
        settings().secrets = { ...settings().secrets, [profile.id]: secret?.id ?? null };
        ctx().saveSettingsDebounced();
        renderModels(list);
        out.textContent = secret && secret.id !== profile['secret-id'] ? `${list.length}, ключ: ${secret.label}` : String(list.length);
    } catch (e) {
        out.textContent = e.message;
        renderModels([], true);
    }
}

const NUMERIC = [
    ['batchGame', 'Пачка в игре'],
    ['batchPass', 'Пачка в проходе'],
    ['keepLast', 'Оставлять последних'],
    ['timeoutMin', 'Ждать ответ, мин'],
    ['piecesTop', 'Абзацев архива'],
    ['scoreMin', 'Порог'],
    ['memoryLimit', 'Лимит, токенов'],
];

function mountPanel() {
    const host = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!host || document.querySelector('#pamyat_panel')) return;
    const panel = document.createElement('div');
    panel.id = 'pamyat_panel';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Память</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input type="checkbox" id="pamyat_enabled"><span>Включена</span></label>
            <label class="checkbox_label"><input type="checkbox" id="pamyat_icon"><span>Иконка</span></label>
            <label class="checkbox_label"><input type="checkbox" id="pamyat_links"><span>Связи</span></label>
            <label class="checkbox_label"><input type="checkbox" id="pamyat_review"><span>Проверка</span></label>
            <div class="pamyat-status" id="pamyat_status"></div>
            <div class="pamyat-q-buttons">
                <div class="menu_button" id="pamyat_now">Обработать всё</div>
                <div class="menu_button" id="pamyat_pick">Выбрать</div>
                <div class="menu_button" id="pamyat_pass">Пройти чат</div>
                <div class="menu_button displayNone" id="pamyat_stop">Стоп</div>
                <div class="menu_button" id="pamyat_arc">Закрыть арку</div>
                <div class="menu_button" id="pamyat_heroes">Обновить героев</div>
                <div class="menu_button" id="pamyat_unhide">Открыть скрытое</div>
                <div class="menu_button" id="pamyat_import">Лорбук</div>
                <div class="menu_button" id="pamyat_lore_sync">В лорбук</div>
                <div class="menu_button" id="pamyat_reset">Сбросить</div>
            </div>
            <h4>Обработано</h4><div id="pamyat_points"></div>
            <h4>Суть персонажа</h4><div id="pamyat_essence"></div>
            <h4>Проверка</h4><div id="pamyat_questions"></div>
            <div id="pamyat_sections"></div>
            <details class="pamyat-fold"><summary>Уточнения <span id="pamyat_clar_n"></span></summary><div id="pamyat_clar"></div></details>
            <details class="pamyat-fold"><summary>Карточки <span id="pamyat_cards_n"></span></summary><div class="menu_button" id="pamyat_add_card">Добавить</div><div id="pamyat_cards"></div></details>
            <details class="pamyat-fold"><summary>Архив <span id="pamyat_archive_n"></span></summary><div id="pamyat_archive"></div></details>
            <details class="pamyat-fold"><summary>Прошлые анкеты</summary><div id="pamyat_snapshots"></div></details>
            <h4>Настройки</h4>
            <div id="pamyat_settings"></div>
            <h4>Шаблон анкеты</h4><textarea class="text_pole" id="pamyat_template"></textarea>
            <div class="pamyat-row"><label>Подключение</label><select class="text_pole" id="pamyat_profile"></select></div>
            <div class="pamyat-row displayNone" id="pamyat_model_row"><label>Модель</label><select class="text_pole" id="pamyat_model"></select><input class="text_pole displayNone" id="pamyat_model_manual" autocomplete="off"><div class="menu_button" id="pamyat_models">Список</div><span id="pamyat_models_status"></span></div>
            <div class="pamyat-row"><label>Векторы</label><select class="text_pole" id="pamyat_vsource"><option value="kobold">Кобольд</option><option value="ollama">Оллама</option><option value="google">Гугл</option><option value="none">Без векторов</option></select></div>
            <div class="pamyat-row pamyat-vs" data-for="kobold"><input class="text_pole" id="pamyat_kobold" placeholder="Адрес"></div>
            <div class="pamyat-row pamyat-vs" data-for="ollama"><input class="text_pole" id="pamyat_ollama_url" placeholder="Адрес"><input class="text_pole" id="pamyat_ollama_model" placeholder="Модель"></div>
            <div class="pamyat-row pamyat-vs" data-for="google"><select class="text_pole" id="pamyat_google_model"><option>gemini-embedding-001</option><option>gemini-embedding-2</option></select></div>
            <div class="pamyat-row pamyat-vs" data-for="kobold ollama google"><div class="menu_button" id="pamyat_check">Проверить</div><span id="pamyat_kobold_status"></span></div>
        </div></div>`;
    host.append(panel);

    const s = settings();
    const icon = panel.querySelector('#pamyat_icon');
    icon.checked = s.icon !== false;
    icon.addEventListener('change', () => {
        settings().icon = icon.checked;
        ctx().saveSettingsDebounced();
        syncIcon();
    });
    const review = panel.querySelector('#pamyat_review');
    review.checked = s.review;
    review.addEventListener('change', () => {
        settings().review = review.checked;
        ctx().saveSettingsDebounced();
    });
    const links = panel.querySelector('#pamyat_links');
    links.checked = s.links !== false;
    links.addEventListener('change', () => {
        settings().links = links.checked;
        ctx().saveSettingsDebounced();
    });
    const enabled = panel.querySelector('#pamyat_enabled');
    enabled.checked = s.enabled;
    enabled.addEventListener('change', () => {
        settings().enabled = enabled.checked;
        ctx().saveSettingsDebounced();
        if (!enabled.checked) {
            macroText = '';
            ctx().setExtensionPrompt(MODULE, '', 0, 0);
            ctx().setExtensionPrompt(ESSENCE_KEY, '', 1, 0, false, 0);
        }
    });
    const box = panel.querySelector('#pamyat_settings');
    for (const [key, label] of NUMERIC) {
        const row = document.createElement('div');
        row.className = 'pamyat-row';
        row.innerHTML = `<label>${label}</label><input type="number" min="0" step="any" class="text_pole" data-key="${key}">`;
        const input = row.querySelector('input');
        input.value = s[key];
        input.addEventListener('change', () => {
            const min = key === 'keepLast' || key === 'scoreMin' || key === 'batchGame' ? 0 : 1;
            const value = Math.max(min, Number(input.value) || min);
            input.value = value;
            settings()[key] = value;
            ctx().saveSettingsDebounced();
        });
        box.append(row);
    }
    const template = panel.querySelector('#pamyat_template');
    template.value = s.heroTemplate;
    template.addEventListener('change', () => {
        settings().heroTemplate = template.value;
        ctx().saveSettingsDebounced();
    });
    renderProfiles();
    const profileSelect = panel.querySelector('#pamyat_profile');
    profileSelect.addEventListener('change', () => {
        settings().profile = profileSelect.value;
        settings().model = '';
        ctx().saveSettingsDebounced();
        renderModels();
        loadModels();
    });
    panel.querySelector('#pamyat_models').addEventListener('click', loadModels);
    panel.querySelector('.inline-drawer-toggle').addEventListener('click', loadModels);
    for (const id of ['#pamyat_model', '#pamyat_model_manual']) {
        panel.querySelector(id).addEventListener('change', (e) => {
            settings().model = e.target.value.trim();
            ctx().saveSettingsDebounced();
        });
    }
    const vsource = panel.querySelector('#pamyat_vsource');
    const syncSource = () => panel.querySelectorAll('.pamyat-vs').forEach((row) => row.classList.toggle('displayNone', !row.dataset.for.split(' ').includes(settings().vectorSource)));
    vsource.value = s.vectorSource;
    syncSource();
    vsource.addEventListener('change', async () => {
        settings().vectorSource = vsource.value;
        ctx().saveSettingsDebounced();
        syncSource();
        document.querySelector('#pamyat_kobold_status').textContent = '';
        if (memory?.id) await vectorizeNew();
    });
    for (const [id, key] of [['#pamyat_kobold', 'koboldUrl'], ['#pamyat_ollama_url', 'ollamaUrl'], ['#pamyat_ollama_model', 'ollamaModel'], ['#pamyat_google_model', 'googleModel']]) {
        const field = panel.querySelector(id);
        field.value = s[key];
        field.addEventListener('change', () => {
            settings()[key] = field.value.trim();
            ctx().saveSettingsDebounced();
        });
    }
    panel.querySelector('#pamyat_check').addEventListener('click', checkVectors);
    panel.querySelector('#pamyat_now').addEventListener('click', () => processTo(ctx().chat.length));
    panel.querySelector('#pamyat_pick').addEventListener('click', startPick);
    panel.querySelector('#pamyat_pass').addEventListener('click', () => runPass());
    panel.querySelector('#pamyat_stop').addEventListener('click', () => { stopPass = true; });
    panel.querySelector('#pamyat_arc').addEventListener('click', () => (generating ? toast('Идёт ответ', 'warning') : withBusy(async () => {
        await ensureMemory();
        if (memory) await closeArc();
    })));
    panel.querySelector('#pamyat_heroes').addEventListener('click', () => (generating ? toast('Идёт ответ', 'warning') : withBusy(async () => {
        await ensureMemory();
        if (memory) await updateHeroes();
    })));
    panel.querySelector('#pamyat_unhide').addEventListener('click', async () => {
        await ensureMemory();
        if (memory) await unhideOurs();
    });
    panel.querySelector('#pamyat_import').addEventListener('click', () => importDialog().catch((e) => toast(e.message, 'error')));
    panel.querySelector('#pamyat_lore_sync').addEventListener('click', () => syncLore().catch((e) => toast(e.message, 'error')));
    panel.querySelector('#pamyat_reset').addEventListener('click', () => resetDialog().catch((e) => toast(e.message, 'error')));
    panel.querySelector('#pamyat_add_card').addEventListener('click', async () => {
        await ensureMemory();
        if (!memory) return;
        await ensureLink();
        memory.cards.push({ id: `c${Date.now()}`, name: 'Новая', type: 'person', line: '', links: [], text: '', always: false, locked: false, proposed: null });
        await saveMemory();
        renderCards();
    });
    renderPanel();
}

// ---------- Запуск ----------

(async function init() {
    const c = ctx();
    const { eventSource, eventTypes: E } = c;
    settings();
    // Сбой одного шага не должен оставить панель без чата и без значка.
    const step = (fn) => {
        try {
            fn();
        } catch (e) {
            console.error('[Память]', e);
            toast(`Запуск: ${e.message}`, 'error');
        }
    };
    step(mountFired);
    step(mountPanel);
    // Без памяти {{summary}} работает как обычно: поле встроенного саммари, потом сообщения чата.
    const summaryFallback = () => document.querySelector('#memory_contents')?.value || [...ctx().chat].reverse().slice(1).find((m) => m.extra?.memory)?.extra.memory || '';
    step(() => c.registerMacro('pamyat', () => (macroSlot === 'pamyat' ? macroText : '')));
    step(() => c.registerMacro('summary', () => (macroSlot === 'summary' && macroText ? macroText : summaryFallback())));
    eventSource.on(E.GENERATION_STARTED, (type, _o, dry) => { if (!dry && type !== 'quiet') { generating = true; endPick(); } });
    eventSource.on(E.GENERATION_STOPPED, () => { generating = false; });
    step(() => eventSource.on(E.WORLDINFO_ENTRIES_LOADED, onLoreLoaded));
    eventSource.on(E.GENERATION_ENDED, () => {
        generating = false;
        setTimeout(() => maybeAuto().catch((e) => console.error('[Память]', e)), 300);
    });
    eventSource.on(E.CHAT_CHANGED, async () => {
        snoozeUntil = 0;
        behindWarned = false;
        endPick();
        blind = { mes: -1, ids: [] };
        lastInjected = new Set();
        c.setExtensionPrompt(MODULE, '', 0, 0);
        c.setExtensionPrompt(ESSENCE_KEY, '', 1, 0, false, 0);
        macroText = '';
        try {
            await loadMemory();
        } catch (e) {
            console.error('[Память]', e);
            toast(e.message, 'error');
        }
        renderPanel();
    });
    eventSource.on(E.MESSAGE_RECEIVED, (id) => { if (typeof id === 'number') markBlind(id); renderStatus(); });
    eventSource.on(E.USER_MESSAGE_RENDERED, renderStatus);
    try {
        await loadMemory();
    } catch (e) {
        console.error('[Память]', e);
        toast(e.message, 'error');
    }
    renderPanel();
})();

// Для автотестов.
globalThis.pamyat_debug = { runPass, processNow, get memory() { return memory; }, get busy() { return busy; }, get points() { return points; }, processed, vectors: () => vectors, fired: () => fired, macro: () => macroText || (ctx().extensionPrompts[MODULE]?.value ?? ''), get promptText() { return macroText || (ctx().extensionPrompts[MODULE]?.value ?? ''); } };
