// Чистая логика без таверны и браузера. Проверяется тестами в tests/lib.test.mjs.

export const SECTIONS = [
    ['now', 'сейчас', 'Сейчас'],
    ['threads', 'незакрытые_нити', 'Нити'],
    ['secrets', 'секреты', 'Секреты'],
    ['met', 'кто_с_кем_встречался', 'Встречи'],
    ['relations', 'отношения', 'Отношения'],
    ['events', 'события', 'События'],
    ['moments', 'памятные_моменты', 'Моменты'],
    ['items', 'вещи', 'Вещи'],
    ['facts', 'постоянное', 'Постоянное'],
];

export const FORBIDDEN = ['по-прежнему', 'до сих пор', 'всё ещё', 'все еще', 'всё так же', 'все так же', 'ещё более', 'еще более', 'стал ещё', 'стала ещё', 'как и раньше', 'больше не'];
// Анкета на сейчас: по итогам игры, при таймскипе на годы меняется почти всё.
const PRESENT = `Разделы о настоящем приведи к состоянию на текущую дату сюжета по итогам игры: возраст (по дате рождения), внешность (рост, фигура, волосы, шрамы, как одевается), характер (если в игре герой стал другим: вырос, замкнулся, стал увереннее), занятие, где живёт, семья (новые родственники, смерти, возраст родственников), отношения. Если прошли годы или герой вырос из ребёнка, меняй смело, раздел целиком. Пиши как состояние на сейчас, без сравнений с прошлым: ${FORBIDDEN.join(', ')}.`;
// Суть: характер и манера речи по описанию героя. Пишется один раз, потом не меняется.
const ESSENCE = 'одно предложение, до 200 символов: характер и как говорит (тон, длина фраз, словечки, как держится с людьми), только по описанию героя в анкеты_героев, не по сообщениям. Без фактов анкеты: имени, возраста, работы, семьи, внешности, сюжета.';

export const DEFAULTS = {
    enabled: true,
    batchGame: 20,
    batchPass: 50,
    keepLast: 10,
    timeoutMin: 10,
    piecesTop: 12,
    cardsTop: 4,
    scoreMin: 0.35,
    memoryLimit: 14000,
    promoteAfter: 3,
    forgetAfter: 300,
    vectorSource: 'none',
    koboldUrl: 'http://127.0.0.1:5001',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'bge-m3',
    googleModel: 'gemini-embedding-001',
    profile: '',
    model: '',
    secrets: {},
    heroTemplate: '',
    maxTokens: 20000,
    icon: true,
    links: true,
    review: true,
};

export function emptyMemory(id = '') {
    return {
        version: 1,
        id,
        chat: '',
        processed: null,
        sections: {},
        archive: [],
        cards: [],
        clarifications: [],
        questions: [],
        arcHint: null,
        arcEnd: null,
        arcName: '',
        snapshots: [],
        hiddenRanges: [],
        inFlight: null,
    };
}

export const cleanDash = (s) => String(s ?? '').replace(/\s*—\s*/g, ' - ').replace(/^ - /gm, '- ').trim();

export function hash(text) {
    let h = 5381;
    for (const c of String(text)) h = ((h * 33) ^ c.codePointAt(0)) >>> 0;
    return h.toString(36);
}

export const anchorOf = (message, idx) => ({ idx, send_date: String(message?.send_date ?? ''), hash: hash(message?.mes ?? '') });

// Сообщения могут удаляться, поэтому «обработано до» ищется по самому сообщению, а не по номеру.
// Возвращает количество обработанных сообщений.
export function processedCount(chat, anchor) {
    if (!anchor) return 0;
    const matches = (i) => chat[i] && String(chat[i].send_date ?? '') === anchor.send_date && hash(chat[i].mes ?? '') === anchor.hash;
    for (let i = Math.min(anchor.idx, chat.length - 1); i >= 0; i--) if (matches(i)) return i + 1;
    for (let i = anchor.idx + 1; i < chat.length; i++) if (matches(i)) return i + 1;
    // Само сообщение удалено: считаем, что оно стояло на том же месте.
    return Math.min(anchor.idx + 1, chat.length);
}

export const isOoc = (text) => /^\s*\(\(\s*ooc\b[\s\S]*\)\)\s*$/i.test(text);
export const stripOoc = (text) => String(text ?? '').replace(/\(\(\s*ooc\b[\s\S]*?\)\)/gi, '').trim();

// Саммари пользователя: длинное скрытое сообщение от пользователя.
export const isUserSummary = (m) => Boolean(m.is_user && m.is_system && String(m.mes ?? '').length >= 1200);

export function batchMessages(chat, from, to) {
    const out = [];
    for (let i = from; i < to && i < chat.length; i++) {
        const m = chat[i];
        if (!m || isUserSummary(m)) continue;
        const text = stripOoc(m.mes);
        if (!text) continue;
        out.push({ id: i, name: m.name, text });
    }
    return out;
}

// Макросы в тексте запроса: сама таверна их тут не подставляет.
export const fillNames = (text, char, user) => String(text).replace(/\{\{char\}\}/g, char || 'героя').replace(/\{\{user\}\}/g, user || 'героя');

export const formatMessages = (messages) => messages.map((m) => `[#${m.id}] ${m.name}:\n${m.text}`).join('\n\n');

export function formatMemory(memory) {
    const parts = [];
    for (const [key, tag] of SECTIONS) {
        const text = memory.sections[key];
        if (text) parts.push(`<${tag}>\n${text}\n</${tag}>`);
    }
    if (memory.clarifications.length) parts.push(`<уточнения>\n${memory.clarifications.map((c) => `- ${c.text}`).join('\n')}\n</уточнения>`);
    return parts.join('\n');
}

const RULES = `Правила текста:
- Записи на английском: так короче. Всё по-английски, даже если раздел или карточка раньше были по-русски и даже если сообщение проще переписать как есть: текст сообщений не копировать, а пересказывать. Ни одной детали не терять. Имена всегда кириллицей, как в сообщениях, без транслита и без сокращений: «Анна», не «Anna» и не «А.». По-русски, как есть: имена, прозвища, названия мест, книг и организаций, заголовки записей, а также прямая речь, цитаты и мысли в «ёлочках» дословно. Ключи, строки карточек, вопросы и варианты ответов только по-русски.
- Длинное тире запрещено, вместо него двоеточие, запятая или дефис.
- Даты обязательны: в «сейчас», в «события», в «памятные_моменты», в записях архива. Если дата известна по блоку Info Box, бери её. В «сейчас» и в заголовках записей дата всегда с днём недели: если он не назван, а календарь обычный, посчитай по дате.
- Источник только сообщения. Ничего не додумывать. Но разделы «постоянное» и «уточнения» написаны автором и важнее сообщений: если сообщение им противоречит, верь им.
- Имена, фамилии, возраст и родство только если прямо названы в сообщениях. Неизвестное имя не придумывать: писать «отец {{char}}».
- Сообщения вида ((OOC ...)) и пересказы прошлого игнорировать. Если сцена переписана, верна последняя версия.
- Домыслы не записывать: «впервые», «единственный», «из уважения» только если это прямо сказано.
- Внутри значений атрибутов нельзя ставить прямые кавычки, только «ёлочки».`;

// Вопросы задаёт только запрос памяти: в архиве, арке и анкетах им некуда идти.
const QUESTIONS = `- Деталь, которая противоречит другой, не записывать: задать вопрос. Текст вопроса одной короткой строкой, номера сообщений не нужны.
- Вопрос только о том, что вернётся в сюжете: где кто живёт, родство, имена, важные даты. Противоречие в мелочи (цвет, сколько раз) записать по последней версии без вопроса. Не повторять то, что уже есть в «уже_спрошено», даже другими словами.`;

// Анкеты читает сам автор, они остаются русскими.
const RULES_RU = RULES.replace(/- Записи на английском[^\n]*\n/, '- Только русский язык.\n');

// Норма каждого раздела. Раздел больше нормы модель возвращает сжатым целиком: память не растёт без конца.
export const SECTION_LIMITS = { now: 800, threads: 2500, secrets: 4000, met: 1500, relations: 1500, events: 4000, moments: 2000, items: 1200 };

// Только для разделов памяти: архив не сжимается.
const MEMORY_SIZE = `- Норма разделов в символах: ${SECTIONS.filter(([k]) => SECTION_LIMITS[k]).map(([k, tag]) => `${tag} ${SECTION_LIMITS[k]}`).join(', ')}.`;

export function oversized(memory) {
    return SECTIONS.filter(([k]) => SECTION_LIMITS[k] && (memory.sections[k] ?? '').length > SECTION_LIMITS[k]).map(([k, tag]) => ({ key: k, tag, length: memory.sections[k].length, limit: SECTION_LIMITS[k] }));
}

function sizeNote(memory) {
    const over = oversized(memory);
    if (!over.length) return '';
    return `Разделы больше нормы: ${over.map((x) => `${x.tag} (${x.length}, норма ${x.limit})`).join(', ')}. Каждый из них верни целиком в виде <раздел имя="...">текст</раздел>, сжатым до нормы и уже с новым из этой пачки: старое и мелкое короче, главное остаётся. Убранное не теряется, оно остаётся в поиске.\n\n`;
}

const heroBlock = (info = []) => {
    const text = info.filter((h) => h.description).map((h) => `${h.name}:\n${h.description}`).join('\n\n');
    return text ? `<анкеты_героев>\n${text}\n</анкеты_героев>\n\n` : '';
};

export function promptPartOne(memory, messages, heroes, heroInfo = []) {
    const list = memory.cards.map((c) => `- ${c.name}${c.locked ? ' (не менять)' : ''}: ${c.line || ''}`).join('\n') || 'нет';
    const clar = memory.clarifications.map((c) => `- [${c.id}] ${c.text}`).join('\n') || 'нет';
    const asked = memory.questions.length ? `<уже_спрошено>\n${memory.questions.map((q) => `- ${q.text}`).join('\n')}\n</уже_спрошено>\n\n` : '';
    const lore = memory.cards.filter((c) => c.lore).map((c) => `${c.name}: ${c.lore}`).join('\n\n');
    const loreBlock = lore ? `<справка_автора>\n${lore}\n</справка_автора>\n\n` : '';
    // Полный текст карточек тех, кто есть в пачке: иначе при обновлении старые детали потеряются.
    const inBatch = mentionedCards(memory.cards, messages.map((m) => m.text).join('\n')).filter((c) => c.text && c.text !== c.lore);
    const overSize = sizeNote(memory);
    // Суть пишется один раз, по описанию: только тем, у кого её нет и есть описание.
    const needEssence = heroInfo.filter((h) => h.description && !memory.essence?.[h.name]).map((h) => h.name);
    const fullBlock = inBatch.length ? `<карточки_полностью>\n${inBatch.map((c) => `${c.name}: ${c.text}`).join('\n\n')}\n</карточки_полностью>\n\n` : '';
    return {
        system: `Ты ведёшь память длинной ролевой игры. Главные герои: ${heroes.join(', ')}. Карточки на них не создавать.\n\n${RULES}\n${QUESTIONS}\n${MEMORY_SIZE}\n\nРазделы:\n- сейчас: дата, день недели, место, текущая ситуация.\n- незакрытые_нити: только то, что должно произойти или решиться: обещания, планы, договорённости, открытые вопросы. То, что уже есть в разделе секреты, сюда не писать. Факты и настроения сюда не писать. Нить убирать, только если в новых сообщениях она решилась или стала невозможной. Прошедшее время и пропуск времени сами нить не закрывают: невыполненное обещание, пророчество, неотвеченный вопрос остаются.\n- секреты: только нераскрытые тайны: что герой скрывает от другого героя или от окружающих и что от этого зависит в сюжете. Одна строка на тайну: кто скрывает, от кого, что, кто уже знает. Тайну убирать, только если в новых сообщениях она раскрылась всем, от кого её скрывали. Если узнал кто-то один, строку не убирать, а поправить: кто теперь знает, кто ещё нет. Прошедшее время и пропуск времени тайну не раскрывают. Что герой узнал, увидел или услышал, сюда не писать: это события. «Остальные не знают» только если от этого зависит сюжет. Личные тайны второстепенных персонажей пишутся в их карточки, а не сюда.\n- кто_с_кем_встречался: только личные встречи: первая встреча и встречи, после которых что-то изменилось. Одна строка на встречу, время без минут. Повторные встречи без перемен не перечислять.\n- отношения: текущее состояние пар. Закрытое одной строкой.\n- события: связный рассказ по периодам, не обрывки и не цитаты. Чем старее, тем короче. Текущая арка по дням.\n- памятные_моменты: только поворотные моменты и слова, которые вернутся в сюжете, не больше трёх за день. Хронологию сюда не писать, она в событиях. Законченные предложения с датой: что случилось и чем важно. Голые цитаты и наборы слов запрещены.\n- вещи: предметы, важные для героев (книга, игрушка, письмо, ключ): у кого или где лежит сейчас и с какого сообщения. Каждая передача вещи меняет запись. Пустяки, которые больше не всплывут, не записывать.\n\nАрка: законченный крупный этап истории: таймскип, завершённый квест или конфликт, закрытая линия. Отдельная сцена или день аркой не считается.\n\nКарточки: только NPC и места. Карточка отвечает на вопрос «кто это»: кем приходится героям, чем занят, где живёт, внешность, характер, как говорит, что о нём важно знать. Для места: что это, где, как выглядит, чем важно. События, хронологию и сцены в карточку не писать: они в событиях и архиве. Карточку дополнять, только если узнали новое о том, кто это, или изменилось его положение (переехал, сменил работу, умер). Новую карточку возвращай, только если появилось что-то новое про этого человека или место. Описание пиши как состояние на сейчас, без сравнений с прошлым: ${FORBIDDEN.join(', ')}. Существующую карточку целиком не возвращай: только правки. Убирай только то, что опровергнуто сюжетом. То, что перестало быть верным, остаётся в архиве.\n\nОтвет только об изменениях: что осталось как было, не упоминать и не повторять. Раздел без изменений не упоминать. Текст в <было> и в <убрать> копировать из памяти или карточки дословно, символ в символ, обычно одну строку; править и убирать в карточке можно только то, что есть в карточки_полностью.\n\nВопросы: ищи противоречия в том, что вернётся в сюжете (места, время, фамилии, возраст, родство, у кого находится вещь), и выдуманное прошлое (встреч, которых нет в памяти). На каждый вопрос готовь варианты ответа.\n\nСправка автора, если есть: достоверные имена, фамилии и родство, но описывает людей в конце истории. Имена бери оттуда. Возраст и внешность считай по текущей дате сюжета. О чём в сообщениях ещё не было речи, в память не записывай.\n\nАнкеты героев, если есть, могут описывать их позже, чем идут эти сообщения. Дата рождения в них достоверна: возраст героев считай по ней, даже если в сообщении написано иначе. Остальное из анкет не переносить в прошлое.\n\nВ тексте карточки возраст не пиши. Год рождения указывай в атрибуте рождение: посчитай по названному возрасту и текущей дате сюжета.${needEssence.length ? `\n\nСуть по-русски для: ${needEssence.join(', ')}. ${ESSENCE}` : ''}`,
        user: `${heroBlock(heroInfo)}${loreBlock}${fullBlock}<память>\n${formatMemory(memory) || 'пусто'}\n</память>\n\n<карточки>\n${list}\n</карточки>\n\n<уточнения_с_номерами>\n${clar}\n</уточнения_с_номерами>\n\n${asked}<новые_сообщения>\n${formatMessages(messages)}\n</новые_сообщения>\n\n${overSize}Верни только изменения, строго в этом виде:\n<раздел имя="сейчас">новый текст раздела «сейчас» целиком</раздел>\n<дополнить раздел="события">новый текст в конец раздела</дополнить>\n<правка раздел="вещи"><было>точная копия куска</было><стало>новый текст</стало></правка>\n<убрать раздел="незакрытые_нити">точная копия куска</убрать>\n<дополнить карточка="Имя">новый текст в конец карточки</дополнить>\n<правка карточка="Имя"><было>точная копия куска</было><стало>новый текст</стало></правка>\n<убрать карточка="Имя">точная копия куска</убрать>\n<поля карточка="Имя" строка="новая строка" ключи="только новые ключи" связи="все связи" рождение="год"/> (только изменившиеся атрибуты)\nНовая карточка, только если такой ещё нет:\n<карточка имя="Имя" тип="персонаж или место" строка="главное одной строкой, без возраста" связи="Имя, Имя" ключи="всё, чем его зовут и называют в тексте: имена, прозвища, родство, должность; сколько угодно, через запятую; каждый ключ одно или два слова, например: соседка, Анна, Аня, Петровна" рождение="год">описание</карточка>\n<вопрос текст="Дверь красная или синяя?"><вариант факт="Дверь красная">красная</вариант><вариант факт="Дверь синяя">синяя</вариант></вопрос>\n<нужно номер="номер уточнения, которое снова понадобилось"/>\n<арка конец="да или нет" имя="Название арки" сообщение="номер последнего сообщения закончившейся арки"/>${needEssence.length ? `\n<суть имя="Имя">одно предложение по-русски</суть> (только для: ${needEssence.join(', ')})` : ''}\n<конец/>\n\nЯзык: английский, имена кириллицей${needEssence.length ? ', суть по-русски' : ''}.\nОтвет обязан заканчиваться строкой <конец/>.`,
    };
}

const authorFacts = (memory) => {
    const facts = [memory.sections.facts, ...memory.clarifications.map((c) => `- ${c.text}`)].filter(Boolean).join('\n');
    return facts ? `<факты_автора>\n${facts}\n</факты_автора>\n\n` : '';
};

export function promptPartTwo(memory, messages, heroInfo = []) {
    const last = memory.archive.slice(-3).map((a) => `- ${a.head}`).join('\n') || 'нет';
    return {
        system: `Ты ведёшь архив длинной ролевой игры: подробные записи по сценам, без потерь.\n\n${RULES}\n\nКаждая запись: дата и место, затем что произошло по порядку, своими словами по-английски, с важными репликами дословно. Текст сообщений целиком не копировать. Одна запись на одну сцену. Запрещено терять детали. Возраст героев считай по дате рождения из анкет и фактов автора. Факты автора важнее сообщений. Сохраняй: реплики дословно, особенно слова, которые могут вернуться позже; мысли и чувства героя, от чьего лица идёт рассказ; имена всех второстепенных людей, даже одноразовых (сторож, соседка); быт и привычки (что ест, во что одет, где лежит вещь). На 50 сообщений можно до 20000 символов, сжимать не надо.`,
        user: `${heroBlock(heroInfo)}${authorFacts(memory)}<последние_записи>\n${last}\n</последние_записи>\n\n<новые_сообщения>\n${formatMessages(messages)}\n</новые_сообщения>\n\nВерни строго в этом виде:\n<запись заголовок="дата (день недели), место, время суток" ключи="русские слова для поиска: люди, места, вещи, события; сколько угодно; каждый ключ одно или два слова">текст</запись>\n<конец/>\n\nОтвет обязан заканчиваться строкой <конец/>.`,
    };
}

// Автообновление не трогает последний ответ ИИ: его ещё могут свайпнуть.
export function autoEnd(chat) {
    const last = chat.at(-1);
    return last && !last.is_user && !last.is_system ? chat.length - 1 : chat.length;
}

export const isComplete = (text) => /<конец\s*\/>/.test(String(text ?? ''));

// Оборванный ответ: что уже пришло целиком и что осталось спросить.
const WHOLE = /<правка\s[^>]*>[\s\S]*?<\/правка>|<дополнить\s[^>]*>[\s\S]*?<\/дополнить>|<суть\s[^>]*>[\s\S]*?<\/суть>|<описание\s[^>]*>[\s\S]*?<\/описание>|<раздел\s[^>]*>[\s\S]*?<\/раздел>|<карточка\s[^>]*>[\s\S]*?<\/карточка>|<вопрос\s[^>]*>[\s\S]*?<\/вопрос>|<запись\s[^>]*>[\s\S]*?<\/запись>|<убрать\s[^>]*>[\s\S]*?<\/убрать>|<поля\s[^>]*\/>|<нужно\s[^>]*\/>|<арка\s[^>]*\/>/g;

export function wholeParts(text) {
    return (String(text ?? '').match(WHOLE) ?? []).join('\n');
}

// Кусок после последней целой части: на нём ответ и оборвался.
function cutTail(text) {
    let end = 0;
    for (const m of String(text).matchAll(WHOLE)) end = m.index + m[0].length;
    return String(text).slice(end).trim();
}

// Склейка продолжения. Модель начала часть заново: оборванный кусок не нужен. Повтор на стыке убирается.
export function joinCut(got, more) {
    const next = String(more ?? '').trimStart();
    if (/^<(?:правка|дополнить|убрать|поля|суть|описание|раздел|карточка|вопрос|запись|нужно|арка|конец)[\s/>]/.test(next)) return `${wholeParts(got)}\n${next}`;
    for (let n = Math.min(300, next.length); n >= 10; n--) {
        if (got.endsWith(next.slice(0, n))) return got + next.slice(n);
    }
    return got + next;
}

export function promptContinue(prompt, got) {
    // Правки различаются только текстом, поэтому им в список идёт сам текст.
    const names = (got.match(WHOLE) ?? []).map((x) => {
        if (/^<(правка|дополнить|убрать|поля)\s/.test(x)) return `- ${x}`;
        const m = /^<(\S+)[^>]*?(?:имя|заголовок|текст)="([^"]*)"/.exec(x);
        return m ? `- ${m[1]}: ${m[2]}` : '';
    }).filter(Boolean);
    const tail = cutTail(got);
    return { system: prompt.system, user: `${prompt.user}\n\nТвой прошлый ответ оборвался. Уже получено, не повторять:\n${names.join('\n')}\n\n${tail ? `Оборвалось на этом месте:\n${tail.slice(-300)}\n\nПродолжи с этого места, сразу следующим символом, без вступления и без повтора, и закрой начатое. Потом верни` : 'Верни'} только то, чего тут нет, в том же виде. Ответ обязан заканчиваться строкой <конец/>.` };
}

// Точки отката. Архив и убранное только дополняются, поэтому в точке лежит их длина, а сами они общие.
const POINT_SKIP = ['archive', 'dropped', 'snapshots', 'hiddenRanges', 'inFlight', 'id', 'chat', 'heroLabels', 'heroArchiveAt', 'essence'];
export const POINT_LIMIT = 20;

export const emptyPoints = () => ({ archive: [], dropped: [], points: [], at: -1 });

export function pointOf(memory) {
    const point = { at: new Date().toISOString(), archiveLen: memory.archive.length, droppedLen: memory.dropped?.length ?? 0, head: memory.archive.at(-1)?.head ?? '' };
    point.state = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(memory).filter(([k]) => !POINT_SKIP.includes(k)))));
    return point;
}

// Подпись точки («Арка») остаётся при перезаписи.
const repoint = (old, memory) => ({ ...pointOf(memory), ...(old?.label ? { label: old.label } : {}) });

// Правка после обработки попадает в её же точку, а не становится новой.
export function refreshPoint(store, memory) {
    if (store.at < 0) return store;
    store.points[store.at] = repoint(store.points[store.at], memory);
    store.archive = [...memory.archive];
    store.dropped = [...(memory.dropped ?? [])];
    return store;
}

const keepTail = (list, tail) => [...list, ...tail.slice(list.length)];

export function addPoint(store, memory, limit = POINT_LIMIT) {
    store.points = store.points.slice(0, store.at + 1);
    store.points.push(pointOf(memory));
    store.points = store.points.slice(-limit);
    store.at = store.points.length - 1;
    store.archive = [...memory.archive];
    store.dropped = [...(memory.dropped ?? [])];
    return store;
}

// Текущее сохраняется на своё место, поэтому вернуться вперёд можно с правками.
export function rollTo(store, memory, i) {
    if (!store.points[i] || i === store.at) return memory;
    if (store.points[store.at]) store.points[store.at] = repoint(store.points[store.at], memory);
    store.archive = keepTail(memory.archive, store.archive);
    store.dropped = keepTail(memory.dropped ?? [], store.dropped);
    const point = store.points[i];
    store.at = i;
    const restored = { ...memory, ...JSON.parse(JSON.stringify(point.state)), archive: store.archive.slice(0, point.archiveLen), dropped: store.dropped.slice(0, point.droppedLen), inFlight: null };
    // В старых точках уточнений нет: остаются те, что были к этому сообщению.
    if (!point.state.clarifications) {
        const limit = (point.state.processed?.idx ?? -1) + 1;
        restored.clarifications = memory.clarifications.filter((c) => (c.lastSeen ?? 0) <= limit);
    }
    restored.heroArchiveAt = Object.fromEntries(Object.entries(memory.heroArchiveAt ?? {}).map(([k, v]) => [k, Math.min(v, point.archiveLen)]));
    return restored;
}

const attr = (raw, name) => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(raw ?? '');
    return m ? cleanDash(m[1]) : '';
};

function matchAll(text, re) {
    return [...String(text).matchAll(re)];
}

// Модель иногда ошибается в имени раздела («кто_с_семи_встречался»): берётся ближайшее, если ошибка в паре букв.
function editDistance(a, b) {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = d[0];
        d[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const keep = d[j];
            d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = keep;
        }
    }
    return d[b.length];
}

export function sectionByTag(name) {
    const tag = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!tag) return undefined;
    const exact = SECTIONS.find(([, t]) => t === tag);
    if (exact) return exact;
    const [best, dist] = SECTIONS.map((def) => [def, editDistance(tag, def[1])]).sort((a, b) => a[1] - b[1])[0];
    return dist <= Math.max(2, Math.floor(best[1].length / 5)) ? best : undefined;
}

export function parsePartOne(text) {
    const out = { sections: {}, cards: [], edits: [], questions: [], used: [], arc: null, essence: parseEssence(text) };
    const target = (raw) => {
        const name = attr(raw, 'карточка');
        if (name) return { card: name };
        const key = sectionByTag(attr(raw, 'раздел'))?.[0];
        return key ? { section: key } : null;
    };
    const edit = (raw, fields) => { const t = target(raw); if (t) out.edits.push({ ...t, ...fields }); };
    for (const m of matchAll(text, /<правка\s+([^>]*)>\s*<было>([\s\S]*?)<\/было>\s*<стало>([\s\S]*?)<\/стало>\s*<\/правка>/g)) edit(m[1], { was: cleanDash(m[2]), now: cleanDash(m[3]) });
    for (const m of matchAll(text, /<убрать\s+([^>]*)>([\s\S]*?)<\/убрать>/g)) edit(m[1], { was: cleanDash(m[2]), now: '' });
    for (const m of matchAll(text, /<дополнить\s+([^>]*)>([\s\S]*?)<\/дополнить>/g)) edit(m[1], { add: cleanDash(m[2]) });
    for (const m of matchAll(text, /<поля\s+([^>]*)\/>/g)) {
        const name = attr(m[1], 'карточка');
        if (name) out.edits.push({ card: name, fields: { line: attr(m[1], 'строка'), keys: cleanKeys(attr(m[1], 'ключи').split(',')), links: attr(m[1], 'связи').split(',').map((x) => x.trim()).filter(Boolean), born: Number(attr(m[1], 'рождение')) || null } });
    }
    for (const m of matchAll(text, /<раздел\s+имя="([^"]+)"\s*>([\s\S]*?)<\/раздел>/g)) {
        const def = sectionByTag(m[1]);
        if (def) out.sections[def[0]] = cleanDash(m[2]);
    }
    for (const m of matchAll(text, /<карточка\s+([^>]*)>([\s\S]*?)<\/карточка>/g)) {
        const name = attr(m[1], 'имя');
        if (!name) continue;
        out.cards.push({
            name,
            type: attr(m[1], 'тип').includes('мест') ? 'place' : 'person',
            line: attr(m[1], 'строка'),
            links: attr(m[1], 'связи').split(',').map((s) => s.trim()).filter(Boolean),
            keys: cleanKeys(attr(m[1], 'ключи').split(',')),
            text: cleanDash(m[2]),
            born: Number(attr(m[1], 'рождение')) || null,
        });
    }
    for (const m of matchAll(text, /<вопрос\s+([^>]*)>([\s\S]*?)<\/вопрос>/g)) {
        const options = matchAll(m[2], /<вариант\s*([^>]*)>([\s\S]*?)<\/вариант>/g).map((o) => {
            const label = cleanDash(o[2]);
            return { label, fact: attr(o[1], 'факт') || label };
        });
        const q = attr(m[1], 'текст');
        if (q && options.length) out.questions.push({ text: q, options });
    }
    for (const m of matchAll(text, /<нужно\s+([^>]*)\/>/g)) {
        const id = attr(m[1], 'номер');
        if (id) out.used.push(id);
    }
    const arc = /<арка\s+([^>]*)\/>/.exec(text);
    if (arc) out.arc = { ended: attr(arc[1], 'конец').startsWith('да'), name: attr(arc[1], 'имя'), lastMessage: Number(attr(arc[1], 'сообщение')) || null };
    return out;
}

export function parsePartTwo(text) {
    return matchAll(text, /<запись\s+([^>]*)>([\s\S]*?)<\/запись>/g)
        .map((m) => ({ head: attr(m[1], 'заголовок'), keys: cleanKeys(attr(m[1], 'ключи').split(',')), text: cleanDash(m[2]) }))
        .filter((e) => e.text);
}

const newId = (prefix, list) => {
    let n = list.length + 1;
    while (list.some((x) => x.id === `${prefix}${n}`)) n++;
    return `${prefix}${n}`;
};

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').trim();

// Один человек, даже если имя записано по-разному: «Анна (Аня) Иванова» и «Аня Иванова».
export function sameName(a, b) {
    const words = (s) => norm(s).replace(/[()«»"]/g, ' ').split(/\s+/).filter(Boolean);
    const x = words(a), y = words(b);
    // Общей фамилии мало: это может быть семья.
    const [small, big] = x.length <= y.length ? [x, y] : [y, x];
    if (small.length && small.every((w) => big.includes(w))) return true;
    return x.length >= 3 && y.length >= 3 && x[0] === y[0] && x[1] === y[1];
}

// Импорт из лорбука, без запроса к модели. Текст записи хранится нетронутым как справка.
export function importLore(memory, entries, heroes, world = '') {
    const out = { added: [], updated: [], skipped: [] };
    const heroNames = heroes.map(norm);
    for (const e of entries) {
        const content = cleanDash(e.content);
        if (e.disable || !content) continue;
        const first = content.split(/[.\n]/)[0].trim();
        // Первая строка годится в имя, только если похожа на имя: без двоеточия, кавычек и макросов (записи-диалоги).
        const nameLike = first.split(/\s+/).length <= 5 && first.length <= 50 && !/[:"«»{}*]/.test(first);
        const name = nameLike ? first : cleanDash(e.comment || e.key?.[0] || first.slice(0, 40));
        if (heroNames.some((h) => norm(name) === h || norm(name).startsWith(`${h} `))) {
            out.skipped.push(name);
            continue;
        }
        const line = content.length > 120 ? `${content.slice(0, 120).replace(/\s+\S*$/, '')}...` : content;
        const found = memory.cards.find((c) => sameName(c.name, name));
        const source = world ? { world, uid: e.uid } : undefined;
        const keys = (e.key ?? []).filter((k) => k && !k.startsWith('/'));
        if (found) {
            Object.assign(found, { name, lore: content, line: found.line || line, source, keys: [...new Set([...(found.keys ?? []), ...keys])] });
            out.updated.push(name);
        } else {
            memory.cards.push({ id: newId('c', memory.cards), name, type: 'person', line, links: [], text: content, lore: content, source, keys, always: false, locked: false, proposed: null });
            out.added.push(name);
        }
    }
    return out;
}

// Память отстала от чата (проход не закончен): автообновление ждёт кнопки, анкеты не обновляются.
// Пачка 0: обработка только по кнопке, отставание считается нормой.
export const isBehind = (total, done, settings) => Boolean(settings.batchGame) && total - done > Math.max(settings.batchGame, settings.batchPass);

// Незаконченная пачка доделывается в прежних границах: готовый первый запрос не пропадает.
// Кусок короче неё (выбран руками) идёт как выбран.
export function resumeEnd(inFlight, from, to) {
    if (!inFlight?.one || inFlight.from !== from) return to;
    return inFlight.to > from && inFlight.to <= to ? inFlight.to : to;
}

// Сброс возвращает чат к виду до расширения: память пустая, скрытое открывает index.js.
// Остаются только прошлые анкеты: по ним можно вернуть описания героев.
export function resetMemory(memory) {
    const fresh = emptyMemory(memory.id);
    fresh.chat = memory.chat;
    fresh.snapshots = memory.snapshots;
    fresh.heroLabels = memory.heroLabels;
    return fresh;
}

// Строка, которую модель убрала из раздела, не пропадает: она остаётся в поиске и в панели, но не в каждом запросе.
const GUARDED = new Set(['threads', 'secrets', 'met', 'relations', 'moments', 'items']);

function keepDropped(memory, key, text, to, always = false) {
    if (!always && !GUARDED.has(key)) return;
    memory.dropped ??= [];
    const known = new Set(memory.dropped.map((d) => d.text));
    // Модель нумерует пункты заново: номер не считается изменением.
    const bare = (raw) => raw.replace(/^\s*(?:-|\d+[.)])\s*/, '').trim();
    const kept = new Set(String(text).split('\n').map(bare));
    for (const raw of String(memory.sections[key] ?? '').split('\n')) {
        const line = bare(raw);
        if (line.length < 4 || kept.has(line) || known.has(line)) continue;
        known.add(line);
        memory.dropped.push({ id: newId('d', memory.dropped), section: key, text: line, to });
    }
}

// Записи архива режутся на абзацы: искать и вставлять можно только нужное.
export function splitPieces(text, size = 700) {
    const pieces = [];
    let current = '';
    const flush = () => { if (current.trim()) pieces.push(current.trim()); current = ''; };
    for (const para of String(text).split(/\n+/)) {
        for (const sentence of para.length > size ? para.split(/(?<=[.!?…])\s+/) : [para]) {
            if (current && current.length + sentence.length > size) flush();
            current += `${current ? ' ' : ''}${sentence}`;
        }
        if (current.length > size / 2) flush();
    }
    flush();
    return pieces;
}

export function searchPieces(memory) {
    const out = [];
    const add = (owner, head, text, from, keys = []) => splitPieces(text).forEach((piece, n) => out.push({ id: `${owner}~${n}`, owner, n, head, text: piece, from, keys }));
    memory.archive.forEach((a) => add(a.id, a.head, a.text, a.from, a.keys));
    memory.snapshots.forEach((s) => add(s.id, s.label, s.text));
    (memory.dropped ?? []).forEach((d) => add(d.id, 'Убрано', d.text, d.to));
    return out;
}

function mergePieces(list) {
    const groups = new Map();
    for (const a of list) {
        const key = a.owner ?? a.id;
        if (!groups.has(key)) groups.set(key, { head: a.head, parts: [] });
        groups.get(key).parts.push(a);
    }
    return [...groups.values()].map((g) => `[${g.head}] ${g.parts.sort((x, y) => (x.n ?? 0) - (y.n ?? 0)).map((x) => x.text).join(' [...] ')}`);
}

// Применяет обе части ответа. Возвращает сводку изменений для окна.
// Замена куска: дословно, при несовпадении с точностью до пробелов. null, если куска нет.
export function patchText(base, was, now) {
    let at = base.indexOf(was);
    let len = was.length;
    if (at < 0) {
        const words = was.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const m = words.length ? new RegExp(words.join('\\s+')).exec(base) : null;
        if (!m) return null;
        at = m.index;
        len = m[0].length;
    }
    const out = base.slice(0, at) + now + base.slice(at + len);
    // От убранной строки не остаётся пустого пункта.
    return now ? out : out.split('\n').filter((l) => !/^\s*-\s*$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function applyEdit(base, e, onMiss) {
    if (e.add) return base.includes(e.add) ? base : [base, e.add].filter(Boolean).join('\n');
    if (!e.was) return base;
    const out = patchText(base, e.was, e.now);
    if (out !== null) return out;
    // Новое не теряется, даже если кусок не нашёлся.
    onMiss(e.was);
    return e.now && !base.includes(e.now) ? [base, e.now].filter(Boolean).join('\n') : base;
}

// Правки превращаются в обычный результат: полный текст разделов и карточек.
function resolveEdits(memory, one, summary) {
    const sections = { ...one.sections };
    const cards = [...one.cards];
    const miss = (x) => summary.notApplied.push(x);
    for (const e of one.edits ?? []) {
        if (e.section) {
            sections[e.section] = applyEdit(sections[e.section] ?? memory.sections[e.section] ?? '', e, miss);
            continue;
        }
        let c = cards.find((x) => sameName(x.name, e.card));
        if (!c) {
            const old = memory.cards.find((x) => sameName(x.name, e.card));
            c = { name: old?.name ?? e.card, type: old?.type ?? 'person', line: '', links: [], keys: [], text: old?.text ?? '', born: null };
            cards.push(c);
        }
        if (e.fields) {
            c.line = e.fields.line || c.line;
            c.keys = [...c.keys, ...e.fields.keys];
            c.links = e.fields.links.length ? e.fields.links : c.links;
            c.born = e.fields.born || c.born;
        } else c.text = applyEdit(c.text, e, miss);
    }
    return { sections, cards };
}

export function applyResult(memory, one, two, { from, to, heroes, settings }) {
    const summary = { sections: [], cardsNew: [], cardsUpdated: [], proposed: [], archive: 0, questions: 0, promoted: [], forgotten: [], notApplied: [], essence: [] };
    const heroNames = heroes.map(norm);
    const was = { sections: { ...memory.sections }, cards: new Map(memory.cards.map((c) => [c.id, c.text ?? ''])), archive: memory.archive.length };
    const resolved = resolveEdits(memory, one, summary);
    for (const [key, text] of Object.entries(resolved.sections)) {
        keepDropped(memory, key, text, to);
        memory.sections[key] = text;
        summary.sections.push(key);
    }
    for (const c of resolved.cards) {
        if (heroNames.some((h) => norm(c.name) === h || norm(c.name).startsWith(`${h} `))) continue;
        const found = memory.cards.find((x) => sameName(x.name, c.name));
        if (!found) {
            memory.cards.push({ id: newId('c', memory.cards), always: false, locked: false, proposed: null, ...c });
            summary.cardsNew.push(c.name);
        } else if (found.locked) {
            found.proposed = { text: c.text, line: c.line };
            summary.proposed.push(found.name);
        } else {
            if (found.text && found.text !== c.text) found.versions = [...(found.versions ?? []), { text: found.text, to }].slice(-5);
            found.keys = [...new Set([...(found.keys ?? []), ...(c.keys ?? [])])];
            delete found.ru;
            Object.assign(found, { text: c.text, line: c.line || found.line, links: c.links.length ? c.links : found.links, type: c.type, born: c.born || found.born });
            summary.cardsUpdated.push(found.name);
        }
    }
    for (const q of one.questions) {
        if (memory.questions.some((x) => sameQuestion(x.text, q.text))) continue;
        memory.questions.push({ id: newId('q', memory.questions), ...q });
        summary.questions++;
    }
    for (const e of two) {
        memory.archive.push({ id: newId('a', memory.archive), from, to, ...e });
        summary.archive++;
    }
    for (const c of memory.clarifications) {
        if (one.used.includes(c.id)) {
            c.hits = (c.hits ?? 0) + 1;
            c.lastSeen = to;
        }
    }
    for (const c of [...memory.clarifications]) {
        if ((c.hits ?? 0) >= settings.promoteAfter) {
            memory.sections.facts = [memory.sections.facts, `- ${c.text}`].filter(Boolean).join('\n');
            memory.clarifications.splice(memory.clarifications.indexOf(c), 1);
            summary.promoted.push(c.text);
        } else if (to - (c.lastSeen ?? 0) > settings.forgetAfter) {
            memory.clarifications.splice(memory.clarifications.indexOf(c), 1);
            summary.forgotten.push(c.text);
        }
    }
    // Суть только главных героев и только один раз: готовую не перезаписывает.
    for (const [name, text] of Object.entries(one.essence ?? {})) {
        const hero = heroes.find((h) => sameName(h, name));
        if (!hero || memory.essence?.[hero]) continue;
        memory.essence = { ...memory.essence, [hero]: text };
        summary.essence.push(hero);
    }
    if (one.arc) {
        memory.arcName = one.arc.name || memory.arcName;
        memory.arcHint = one.arc.ended ? (one.arc.name || memory.arcName) : null;
        memory.arcEnd = one.arc.ended ? one.arc.lastMessage : null;
    }
    summary.changes = {
        sections: SECTIONS.filter(([k]) => (was.sections[k] ?? '') !== (memory.sections[k] ?? '')).map(([key, , label]) => ({ key, label, before: was.sections[key] ?? '', after: memory.sections[key] ?? '' })),
        cards: memory.cards.filter((c) => (c.text ?? '') !== was.cards.get(c.id)).map((c) => ({ id: c.id, name: c.name, before: was.cards.get(c.id) ?? '', after: c.text ?? '' })),
        archive: memory.archive.slice(was.archive).map((a) => ({ id: a.id, head: a.head, before: '', after: a.text ?? '' })),
    };
    return summary;
}

// Слова: что осталось, что добавилось, что убралось. Общее начало и конец не сравниваются, поэтому длинный текст с малой правкой считается быстро.
export function diffWords(before, after) {
    const a = String(before ?? '').split(/(\s+)/).filter(Boolean);
    const b = String(after ?? '').split(/(\s+)/).filter(Boolean);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const out = [];
    const push = (t, s) => { if (out.at(-1)?.t === t) out.at(-1).s += s; else if (s) out.push({ t, s }); };
    push('same', a.slice(0, start).join(''));
    const x = a.slice(start, endA);
    const y = b.slice(start, endB);
    if (x.length * y.length > 4000000) {
        push('del', x.join(''));
        push('add', y.join(''));
    } else {
        const w = y.length + 1;
        const lcs = new Uint32Array((x.length + 1) * w);
        for (let i = x.length - 1; i >= 0; i--) {
            for (let j = y.length - 1; j >= 0; j--) {
                lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < x.length || j < y.length) {
            if (i < x.length && j < y.length && x[i] === y[j]) { push('same', x[i]); i++; j++; }
            else if (j < y.length && (i === x.length || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) push('add', y[j++]);
            else push('del', x[i++]);
        }
    }
    push('same', a.slice(endA).join(''));
    return out;
}

// Правки из окна проверки. Правится только то, что изменилось; вернёт, было ли что менять.
export function applyReview(memory, changes) {
    let changed = false;
    for (const x of changes.sections) {
        if (x.edited === undefined || x.edited === x.after) continue;
        memory.sections[x.key] = x.edited;
        changed = true;
    }
    for (const x of changes.cards) {
        const card = memory.cards.find((c) => c.id === x.id);
        if (!card || x.edited === undefined || x.edited === x.after) continue;
        card.text = x.edited;
        delete card.ru;
        changed = true;
    }
    for (const x of changes.archive) {
        const entry = memory.archive.find((a) => a.id === x.id);
        if (!entry || x.edited === undefined || x.edited === x.after) continue;
        entry.text = x.edited;
        changed = true;
    }
    return changed;
}

// Один вопрос другими словами: совпала почти вся короткая формулировка.
const questionWords = (text) => new Set((norm(text).match(/[а-яa-z0-9]{4,}/g) ?? []).map(stemOf));

export function sameQuestion(a, b) {
    const x = questionWords(a);
    const y = questionWords(b);
    if (!x.size || !y.size) return norm(a) === norm(b);
    const common = [...x].filter((w) => y.has(w)).length;
    return common / Math.min(x.size, y.size) > 0.75;
}

export function uniqueQuestions(list) {
    return list.filter((q, i) => !list.slice(0, i).some((x) => sameQuestion(x.text, q.text)));
}

// Ответ на вопрос: выбранный факт попадает в уточнения. «Неважно» (null) только убирает вопрос.
export function answerQuestion(memory, questionId, optionIndex, at) {
    const i = memory.questions.findIndex((q) => q.id === questionId);
    if (i < 0) return false;
    const [q] = memory.questions.splice(i, 1);
    if (optionIndex !== null && q.options[optionIndex]) {
        memory.clarifications.push({ id: newId('u', memory.clarifications), text: q.options[optionIndex].fact, hits: 0, lastSeen: at });
    }
    return true;
}

export function restoreCard(card) {
    const last = card.versions?.pop();
    if (last) card.text = last.text;
    return Boolean(last);
}

export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Склонения: сравниваем по основе имени без окончания.
const stemOf = (word) => {
    const w = norm(word);
    if (w.length > 5) return w.slice(0, -2);
    return w.length >= 4 ? w.slice(0, -1) : w;
};

const NAME_NOISE = new Set(['дядя', 'дяди', 'тетя', 'тети', 'баба', 'бабушка', 'дед', 'дедушка', 'центральная', 'старый', 'старая', 'новый', 'новая', 'большой', 'большая', 'малый', 'малая', 'майор', 'капитан', 'лейтенант', 'полковник', 'сержант', 'доктор', 'врач', 'учитель', 'учительница', 'директор', 'друг', 'сосед', 'соседка', 'двор', 'дом', 'дома']);
// Слова, которые подходят кому угодно: ими можно вызвать карточку, но имя сильнее.
const GENERIC_KEYS = new Set(['мам', 'мама', 'папаша', 'бабка', 'баб', 'пап', 'мать', 'мамочка', 'мамка', 'папа', 'отец', 'папочка', 'батя', 'сын', 'сынок', 'дочь', 'дочка', 'брат', 'сестра', 'муж', 'жена', 'бабушка', 'баба', 'бабуля', 'дед', 'дедушка', 'дядя', 'тетя', 'друг', 'подруга', 'сосед', 'соседка', 'парень', 'девушка', 'мальчик', 'девочка', 'мужчина', 'женщина', 'врач', 'доктор', 'учитель', 'учительница', 'директор', 'майор', 'капитан', 'школа', 'дом', 'двор', 'квартира', 'комната', 'кухня']);

const hasStem = (word, hay) => new RegExp(`(^|[^а-яa-z])${stemOf(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[а-яa-z]*`).test(hay);

const hasPhrase = (key, hay) => new RegExp(`(^|[^а-яa-z])${key.split(/\s+/).map((w) => `${stemOf(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[а-яa-z]*`).join('\\s+')}`).test(hay);

// В скобках прозвище из одного слова считается именем, описание вроде «(друг соседа)» нет.
const nameWords = (name) => norm(name).replace(/\(([^)]*)\)/g, (_, x) => (/\s/.test(x.trim()) ? ' ' : ` ${x} `)).replace(/[«»"]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !NAME_NOISE.has(w));

const isOwn = (word, own) => own.some((o) => stemOf(word).startsWith(o) || o.startsWith(stemOf(word)));
const ownStems = (heroes) => heroes.flatMap((h) => norm(h).split(/\s+/)).map(stemOf);
const quote = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Какое слово текста подошло. У общего слова окончание короткое, чтобы «мать» не находилась в «материале».
const wordIn = (key, hay, generic) => new RegExp(`(?:^|[^а-яa-z])(${quote(stemOf(key))}[а-яa-z]${generic ? '{0,3}' : '*'})(?:$|[^а-яa-z])`).exec(hay)?.[1];

// Все совпавшие имена и ключи карточки. Одно слово текста считается один раз, сколько бы ключей к нему ни подошло.
// Имя героя в чужой карточке не считается.
function keyHits(card, hay, heroes = []) {
    const own = ownStems(heroes);
    const hits = new Map();
    for (const w of nameWords(card.name)) {
        const found = isOwn(w, own) ? null : wordIn(w, hay);
        if (found) hits.set(found, { word: w, name: true });
    }
    for (const k of (card.keys ?? []).map(norm)) {
        if (/\s/.test(k)) {
            if (hasPhrase(k, hay)) hits.set(k.split(/\s+/).map(stemOf).join(' '), { word: k });
            continue;
        }
        if (k.length < 3 || isOwn(k, own)) continue;
        const generic = GENERIC_KEYS.has(k);
        const found = wordIn(k, hay, generic);
        if (found && !hits.has(found)) hits.set(found, { word: k, generic });
    }
    return hits;
}

// Прямое упоминание: имя или свой ключ. Общее слово само по себе не считается.
const mentionOf = (card, hay, heroes = []) => [...keyHits(card, hay, heroes).values()].find((h) => !h.generic)?.word;

// Ключ всегда одно или два слова, их может быть сколько угодно. Длинный ключ разбирается на слова.
export function cleanKeys(keys) {
    const seen = new Set();
    return (keys ?? []).flatMap((k) => {
        const text = String(k).replace(/[«»"]/g, ' ').trim();
        return text.split(/\s+/).length > 2 ? text.split(/\s+/) : [text];
    }).filter((k) => {
        const n = norm(k);
        if (n.length < 3 || seen.has(n)) return false;
        seen.add(n);
        return true;
    });
}

// Старые длинные ключи чистятся один раз. Ключи лорбука и ручные правки после этого не трогаются.
export function cleanCardKeys(memory) {
    if (memory.keysClean === 2) return false;
    for (const c of memory.cards) if (!c.source?.world) c.keys = cleanKeys(c.keys);
    memory.keysClean = 2;
    return true;
}

// ---------- Поиск по редким словам: без векторов и когда векторы недоступны ----------

const wordStems = (text) => new Set((norm(text).match(/[а-яa-z0-9]+/g) ?? []).filter((w) => w.length >= 4).map(stemOf));

// Ключевые слова считаются сами: слово тем важнее, чем в меньшем числе абзацев встречается.
export function keywordRank(pieces, query) {
    const asked = wordStems(query);
    const sets = pieces.map((p) => wordStems(`${p.head ?? ''} ${(p.keys ?? []).join(' ')} ${p.text}`));
    const df = new Map();
    for (const set of sets) for (const w of set) if (asked.has(w)) df.set(w, (df.get(w) ?? 0) + 1);
    const n = pieces.length;
    const need = Math.log(1 + n / 2);
    const rare = Math.max(2, n * 0.1);
    return pieces.map((p, i) => {
        let score = 0;
        for (const w of sets[i]) if (asked.has(w) && df.get(w) <= rare) score += Math.log(1 + n / df.get(w));
        return { p, score };
    }).filter((x) => x.score > 0 && x.score >= need).sort((a, b) => b.score - a.score);
}

export function phraseByWords(text, phrases) {
    const stems = wordStems(text);
    let best = '';
    let top = 0;
    for (const p of phrases) {
        let score = 0;
        for (const w of wordStems(p)) if (stems.has(w)) score++;
        if (score >= top && score) { top = score; best = p; }
    }
    return best;
}

// Хэш для ST: в его хранилище векторов нужны числа.
export const numericHash = (h) => parseInt(h, 36);

// Поле значка сбоку от него: справа, у края слева, а если сбоку тесно, под ним или над ним.
export function boxPlace(icon, view, height, wanted = 420, gap = 8, narrow = 220) {
    const right = view.w - icon.right - gap * 2;
    const left = icon.left - gap * 2;
    const clampTop = (y) => Math.max(gap, Math.min(y, view.h - height - gap));
    if (Math.max(right, left) >= narrow) {
        const onRight = right >= Math.min(wanted, left);
        const width = Math.min(wanted, onRight ? right : left);
        return { left: onRight ? icon.right + gap : icon.left - gap - width, top: clampTop(icon.top), width, maxHeight: view.h - gap * 2 };
    }
    const below = view.h - icon.bottom - gap * 2;
    const above = icon.top - gap * 2;
    const width = Math.min(wanted, view.w - gap * 2);
    const x = Math.max(gap, Math.min(icon.left, view.w - width - gap));
    if (below >= above) return { left: x, top: icon.bottom + gap, width, maxHeight: below };
    const maxHeight = above;
    return { left: x, top: Math.max(gap, icon.top - gap - Math.min(height, maxHeight)), width, maxHeight };
}

export function mentionedCards(cards, text) {
    const hay = norm(text);
    return cards.filter((c) => mentionOf(c, hay));
}

// Кто назван в тексте по имени: всё название целиком или слово из него, которого нет у других карточек.
export function namedCards(cards, text, heroes = []) {
    const hay = norm(text);
    const own = ownStems(heroes);
    const stems = cards.map((c) => nameWords(c.name).map(stemOf));
    const unique = (w) => stems.filter((x) => isOwn(w, x)).length === 1;
    return cards.filter((c) => {
        const whole = norm(c.name).replace(/\([^)]*\)/g, ' ').replace(/[«»"]/g, ' ').trim();
        if (whole && hasPhrase(whole, hay)) return true;
        return nameWords(c.name).some((w) => unique(w) && !isOwn(w, own) && wordIn(w, hay));
    });
}

export function pickCards(memory, options) {
    return [...explainCards(memory, options).keys()];
}

// Карточка и все причины, по которым она попала в запрос.
export function explainCards(memory, { query, ranked = [], extraIds = [], settings, scores = {}, heroes = [] }) {
    const chosen = new Map();
    const add = (c, why) => {
        if (!c) return;
        if (!chosen.has(c)) chosen.set(c, []);
        chosen.get(c).push(why);
    };
    const hay = norm(query);
    memory.cards.filter((c) => c.always).forEach((c) => add(c, 'всегда'));
    const found = memory.cards.map((c) => [c, keyHits(c, hay, heroes)]).filter(([, h]) => h.size);
    const holders = new Map();
    for (const [c, hits] of found) for (const id of hits.keys()) holders.set(id, [...(holders.get(id) ?? []), c]);
    // Редкий ключ весит больше: «мама» на троих даёт каждой треть, имя целиком своё.
    const score = new Map(found.map(([c, hits]) => [c, [...hits.keys()].reduce((sum, id) => sum + 1 / holders.get(id).length, 0)]));
    for (const [c, hits] of found) {
        const list = [...hits.entries()];
        const own = list.find(([id, h]) => h.name || (!h.generic && holders.get(id).length === 1));
        // Только общие слова: карточка приходит, если на эти слова нет претендента сильнее. Слово на четверых и больше только добавляет вес.
        const wins = own || list.some(([id]) => holders.get(id).length <= 3 && holders.get(id).every((x) => score.get(x) <= score.get(c)));
        if (!wins) continue;
        add(c, own ? `имя: ${own[1].word}` : `слово: ${list[0][1].word}`);
        chosen.get(c).score = score.get(c);
    }
    extraIds.forEach((id) => add(memory.cards.find((c) => c.id === id), 'перегенерация'));
    ranked.slice(0, settings.cardsTop).forEach((c) => add(c, `смысл ${(scores[c.id] ?? 0).toFixed(2)}`));
    // Связи только от названных прямо: близкая по смыслу карточка не тянет за собой своих знакомых.
    for (const c of settings?.links === false ? [] : [...chosen.keys()]) {
        if (!chosen.get(c).some((w) => w.startsWith('имя') || w === 'всегда')) continue;
        for (const link of c.links ?? []) add(memory.cards.find((x) => norm(x.name) === norm(link)), `связь: ${c.name}`);
    }
    return chosen;
}

// Какая фраза вызвала запись: сначала имя в тексте, иначе ближайшая по векторам.
export const phrasesOf = (text) => String(text).split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 2).slice(-60);
export const phraseWithName = (card, phrases) => phrases.findLast((p) => keyHits(card, norm(p)).size) ?? '';

export function closestPhrase(vector, phrases, phraseVectors) {
    let best = '';
    let top = -Infinity;
    phrases.forEach((p, i) => {
        const score = cosine(vector, phraseVectors[i]);
        if (score > top) { top = score; best = p; }
    });
    return best;
}

export const entryTitle = (text) => {
    const first = String(text).split(/(?<=[.!?…])\s/)[0].trim();
    return first.length > 70 ? `${first.slice(0, 70).replace(/\s+\S*$/, '')}...` : first;
};

// Записи лорбука, которые отданы памяти: таверна их не вставляет, чтобы не было двойников.
export const loreKey = (world, uid) => `${world}:${uid}`;
export const handedLore = (memory) => new Set((memory?.cards ?? []).filter((c) => c.source?.world).map((c) => loreKey(c.source.world, c.source.uid)));

export function dropHanded(lists, handed) {
    for (const list of lists) {
        for (let i = list.length - 1; i >= 0; i--) {
            if (handed.has(loreKey(list[i].world, list[i].uid))) list.splice(i, 1);
        }
    }
}

// Карточки из лорбука, текст которых память успела изменить.
export const loreChanges = (memory) => (memory?.cards ?? []).filter((c) => c.source?.world && c.lore !== undefined && c.text !== c.lore);

// Год сюжета берётся из раздела «Сейчас», возраст считается сам и не устаревает.
export function storyYear(memory) {
    const found = String(memory.sections.now ?? '').match(/\b(1[0-9]{3}|2[0-9]{3})\b/);
    return found ? Number(found[1]) : null;
}

function ageNote(card, year) {
    if (!card.born || !year || year < card.born) return '';
    return ` ${year - card.born} лет (в ${year}, год рождения ${card.born}).`;
}

export const PROMPT_RULE = 'Прошлое: только то, что здесь записано. Если встречи, разговора или события нет в памяти, его не было. Не придумывать прошлых встреч, «один раз мельком», общих воспоминаний. Если детали нет в памяти, писать без конкретики. Персонаж не может знать или намекать на то, чего не знает по разделу «секреты».';

export function buildPrompt(memory, cards, archive) {
    const body = formatMemory(memory);
    if (!body && !memory.cards.length && !archive.length) return '';
    const shown = new Set(cards.map((c) => c.id));
    const index = memory.cards.filter((c) => !shown.has(c.id)).map((c) => `- ${c.name}: ${c.line || ''}`).join('\n');
    const parts = [`<память>\n${body}\n</память>`];
    if (index) parts.push(`<список_карточек>\n${index}\n</список_карточек>`);
    const year = storyYear(memory);
    if (cards.length) parts.push(`<персонажи_и_места>\n${cards.map((c) => `${c.name}.${ageNote(c, year)} ${c.text}`).join('\n\n')}\n</персонажи_и_места>`);
    if (archive.length) parts.push(`<подробности_из_прошлого>\n${mergePieces(archive).join('\n\n')}\n</подробности_из_прошлого>`);
    parts.push(`<правило>${PROMPT_RULE}</правило>`);
    return parts.join('\n');
}

export const tokensOf = (text) => Math.ceil(String(text).length / 3);

// Важность карточки: 0 всегда, 1 названа в тексте, 2 по смыслу, 3 только по связи. Чем позже названа, тем важнее.
export function cardRanks(why, query) {
    const hay = norm(query);
    const ranks = new Map();
    for (const [card, reasons] of why) {
        const word = reasons.find((w) => w.startsWith('имя'))?.slice(5);
        const tier = reasons.includes('всегда') ? 0 : word ? 1 : reasons.some((w) => w.startsWith('смысл') || w.startsWith('слово') || w === 'перегенерация') ? 2 : 3;
        ranks.set(card, { tier, score: reasons.score ?? 0, pos: word ? hay.lastIndexOf(stemOf(word)) : -1 });
    }
    return ranks;
}

export const ARCHIVE_KEEP = 4;

// Вставка не больше лимита. Сначала уходят карточки по связи, потом по очереди дальний абзац архива и наименее
// важная карточка, пока от архива не останется ARCHIVE_KEEP. Отброшенное остаётся в памяти.
export function fitMemory(memory, cards, archive, limit, ranks = new Map()) {
    const c = [...cards];
    const a = [...archive];
    const tierOf = (x) => ranks.get(x)?.tier ?? (x.always ? 0 : 2);
    const weakest = () => {
        let worst = -1;
        c.forEach((x, i) => {
            if (tierOf(x) === 0) return;
            const [a, b] = [ranks.get(x), ranks.get(c[worst])];
            const weaker = () => ((a?.score ?? 0) !== (b?.score ?? 0) ? (a?.score ?? 0) < (b?.score ?? 0) : (a?.pos ?? -1) <= (b?.pos ?? -1));
            if (worst < 0 || tierOf(x) > tierOf(c[worst]) || (tierOf(x) === tierOf(c[worst]) && weaker())) worst = i;
        });
        return worst;
    };
    let archiveTurn = true;
    while (tokensOf(buildPrompt(memory, c, a)) > limit) {
        const w = weakest();
        if (w >= 0 && tierOf(c[w]) === 3) c.splice(w, 1);
        // Три последних названных уходят только после архива: это те, кто сейчас в сцене.
        else if (a.length > ARCHIVE_KEEP && (archiveTurn || w < 0 || (tierOf(c[w]) === 1 && c.filter((x) => tierOf(x) === 1).length <= 3))) { a.pop(); archiveTurn = false; }
        else if (w >= 0 && (tierOf(c[w]) > 0)) { c.splice(w, 1); archiveTurn = true; }
        else if (a.length) a.pop();
        else break;
    }
    return { cards: c, archive: a };
}

export const descriptionLimit = (old) => Math.max(2500, Math.round(String(old ?? '').length * 1.5));

// Арка сжимает растущие разделы, а не только события. Убранное остаётся в поиске.
// Секреты и нити арка не трогает: тайна и обещание живут дольше арки, их убирает только обычная обработка.
export const ARC_SECTIONS = ['events', 'moments', 'met', 'relations', 'items'];
export const ARC_EVENTS_LIMIT = 800;

export function arcPrompt(memory, { arcEnd = null } = {}) {
    const cut = arcEnd
        ? `Арка закончилась на сообщении #${arcEnd}. Сжимай только то, что было до конца этого сообщения. Всё, что случилось позже, оставь подробно, по дням: это начало новой арки.`
        : 'Сжимай текущую арку целиком.';
    const tags = ARC_SECTIONS.map((k) => SECTIONS.find(([x]) => x === k)[1]);
    const memoryText = SECTIONS.filter(([k]) => ARC_SECTIONS.includes(k) || k === 'now').map(([k, tag]) => memory.sections[k] ? `<${tag}>\n${memory.sections[k]}\n</${tag}>` : '').filter(Boolean).join('\n');
    return {
        system: `Закрывается арка длинной ролевой игры. Сожми память: закрытая арка должна занимать мало места. Подробности остаются в архиве, убранное из разделов тоже остаётся в поиске, поэтому сжимать можно смело.\n\n${RULES}\n\n${cut}\n\nЧто сделать с закрытой аркой:\n- события: один связный абзац, не больше ${ARC_EVENTS_LIMIT} символов: что случилось и почему это важно. Уже закрытые арки (с пометкой arc closed) не удлинять, можно сжать ещё. В начале абзаца даты арки и пометка arc closed.\n- памятные_моменты: от закрытой арки 3-5 самых важных моментов, каждый одним предложением с датой, время без минут.\n- кто_с_кем_встречался: от закрытой арки одна строка на пару: когда впервые встретились и чем это кончилось. Повторные встречи не перечислять.\n- отношения: только как сейчас, одна-две строки на пару. История отношений уже в событиях.\n- вещи: убрать то, что больше не всплывёт.\n\nНичего нового не добавлять: только сжимать, убирать и переводить на английский. Каждый раздел, который поменялся, верни целиком. Раздел без изменений не возвращай. Раздел «сейчас» только для понимания, его не возвращать.`,
        user: `<память>\n${memoryText}\n</память>\n\nВерни строго в этом виде, по одному блоку на раздел (${tags.join(', ')}):\n<раздел имя="события">полный новый текст раздела</раздел>\n<конец/>\n\nЯзык: английский, имена кириллицей.\nОтвет обязан заканчиваться строкой <конец/>.`,
    };
}

// Раздел, который после сжатия стал длиннее, не меняется: значит, модель не сжала, а переписала.
export function applyArc(memory, parsed, { to = 0 } = {}) {
    const summary = { sections: [], cardsNew: [], cardsUpdated: [], proposed: [], archive: 0, questions: 0, promoted: [], forgotten: [], notApplied: [], longer: [] };
    const was = { ...memory.sections };
    for (const key of ARC_SECTIONS) {
        const text = parsed.sections?.[key];
        if (text === undefined || text === (was[key] ?? '')) continue;
        if (text.length > (was[key] ?? '').length) {
            summary.longer.push(key);
            continue;
        }
        keepDropped(memory, key, text, to, true);
        memory.sections[key] = text;
        summary.sections.push(key);
    }
    summary.changes = {
        sections: SECTIONS.filter(([k]) => (was[k] ?? '') !== (memory.sections[k] ?? '')).map(([key, , label]) => ({ key, label, before: was[key] ?? '', after: memory.sections[key] ?? '' })),
        cards: [],
        archive: [],
    };
    return summary;
}

const DEFAULT_TEMPLATE = 'Имя (прозвище):\nВозраст и дата рождения:\nВнешность:\nХарактер:\nПредыстория:\nМесто жительства:\nСемья:';

// Всё, что случилось с прошлого обновления анкеты. Слишком большой архив идёт несколькими запросами.
export function archiveChunks(entries, limit = 150000) {
    const chunks = [];
    let current = [];
    let size = 0;
    for (const entry of entries) {
        const length = String(entry.text ?? '').length + String(entry.head ?? '').length;
        if (current.length && size + length > limit) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(entry);
        size += length;
    }
    if (current.length) chunks.push(current);
    return chunks.length ? chunks : [[]];
}

// Кратко: всё давнее модель берёт из памяти (события по периодам), из архива только последние сцены.
export const BRIEF_ARCHIVE = 30000;
export const BIG_ARCHIVE = 60000;
export const archiveLength = (entries) => entries.reduce((n, e) => n + String(e.text ?? '').length + String(e.head ?? '').length, 0);

export function briefArchive(entries, limit = BRIEF_ARCHIVE) {
    const out = [];
    let size = 0;
    for (const e of [...entries].reverse()) {
        size += String(e.text ?? '').length + String(e.head ?? '').length;
        if (out.length && size > limit) break;
        out.unshift(e);
    }
    return out;
}

export function archiveSince(memory, heroes) {
    const marks = heroes.map((h) => memory.heroArchiveAt?.[h.name] ?? 0);
    return memory.archive.slice(marks.length ? Math.min(...marks) : 0);
}

// Предыстория только о жизни до игры: события игры лежат в памяти, в анкету их не переносить.
const BACKSTORY = 'Разделы о прошлом (предыстория, биография, история) только о жизни героя до начала игры. События игры (всё из памяти и архива) туда не пиши: ни итогом, ни коротко. Туда идут только детство и прошлое до игры, которые герои упоминали в разговорах или мыслях.';

export function heroPrompt(memory, heroes, { tail = [], template = '', archive = memory.archive, brief = false } = {}) {
    const whole = 'В архиве всё, что случилось с прошлого обновления: перечитай его целиком.';
    const read = brief ? 'В архиве только последние сцены. Всё, что было раньше, бери из памяти: события по периодам, отношения, сейчас. Обнови по ним то, что изменилось глобально: где живёт, работа, семья, отношения, возраст, характер. Мелочи сцен не нужны.' : whole;
    const shape = template.trim()
        ? `Шаблон анкеты, строго эти разделы и в этом порядке:\n${template.trim()}`
        : `Шаблон: разделы, их порядок и оформление берутся из старой анкеты героя, новых разделов не добавлять. Только если старой анкеты нет, используй разделы:\n${DEFAULT_TEMPLATE}`;
    const list = heroes.map((h) => `<герой имя="${h.name}" лимит="${descriptionLimit(h.description)}">\n${h.description || 'нет'}\n</герой>`).join('\n');
    if (!template.trim() && heroes.every((h) => h.description)) {
        return {
            system: `Обновляются анкеты главных героев длинной ролевой игры.\n\n${RULES_RU}\n\nАнкету целиком НЕ переписывай. Верни только правки: код применит их к анкете, а весь остальной текст останется нетронутым.\n\nПравка заменяет устаревшее: в было точная цитата из анкеты, символ в символ, в стало новый текст. Для мелочи цитата короткая, для большой перемены цитата весь текст раздела.\n\n${read}\n\n${BACKSTORY} Дополнение дописывает в конец раздела: только так в раздел о прошлом попадает то, что герои упоминали о жизни до игры, если в анкете этого нет.\n\n${PRESENT} Черты и привычки, которые игра не меняла, оставь, даже если они рядом с устаревшим фактом. Родство бери из анкеты и справки, не выводи сам. Ничего не придумывай. То, что не изменилось, не упоминай.`,
            user: `<память>\n${formatMemory(memory)}\n</память>\n<архив>\n${archive.map((a) => `[${a.head}] ${a.text}`).join('\n\n')}\n</архив>\n${tail.length ? `<ещё_не_в_памяти>\n${formatMessages(tail)}\n</ещё_не_в_памяти>\n` : ''}${list}\n\nВерни строго в этом виде:\n<правка имя="Имя"><было>точная цитата</было><стало>новый текст</стало></правка>\n<дополнить имя="Имя" раздел="Предыстория">новый текст в конец раздела</дополнить>\n<подпись имя="Имя" новая="Имя, возраст (время)" старая="Имя, возраст (время)"/>\n<конец/>\n\nОтвет обязан заканчиваться строкой <конец/>.`,
        };
    }
    return {
        system: `Обновляются описания главных героев длинной ролевой игры.\n\n${RULES_RU}\n\n${shape}\n\nОформление точно как в старой анкете или шаблоне: те же названия разделов, те же двоеточия и абзацы, без жирного шрифта и звёздочек. Если есть подразделы (например, родственники списком), сохрани их вид.\n\nСодержание. ${PRESENT} ${BACKSTORY} Предысторию из старой анкеты сохрани дословно. Если старой анкеты нет, пиши предысторию с рождения по тому, что известно о жизни до игры. ${read}\n\nДату рождения, имя и родство не менять. Всё, что в старой анкете ещё верно, оставь дословно: не сокращай и не пересказывай. Родство бери из старой анкеты и справки, не выводи сам. Ничего не придумывай.\n\nДлина не больше значения лимит у героя, в символах: это жёсткое ограничение.`,
        user: `<память>\n${formatMemory(memory)}\n</память>\n<архив>\n${archive.map((a) => `[${a.head}] ${a.text}`).join('\n\n')}\n</архив>\n${tail.length ? `<ещё_не_в_памяти>\n${formatMessages(tail)}\n</ещё_не_в_памяти>\n` : ''}${list}\n\nВерни строго в этом виде:\n<описание имя="Имя" подпись="Имя, возраст (время)" подпись_старого="Имя, возраст (время)">новое описание</описание>\n<конец/>\n\nподпись: возраст и время нового описания. подпись_старого: возраст и время, к которым относится старое описание.\nОтвет обязан заканчиваться строкой <конец/>.`,
    };
}

export function parseArc(text) {
    const events = /<события>([\s\S]*?)<\/события>/.exec(text);
    return {
        events: events ? cleanDash(events[1]) : '',
        descriptions: matchAll(text, /<описание\s+([^>]*)>([\s\S]*?)<\/описание>/g).map((m) => ({ name: attr(m[1], 'имя'), label: attr(m[1], 'подпись'), oldLabel: attr(m[1], 'подпись_старого'), text: cleanDash(m[2]) })),
        essence: parseEssence(text),
        edits: parseHeroEdits(text),
        labels: Object.fromEntries(matchAll(text, /<подпись\s+([^>]*)\/>/g).map((m) => [attr(m[1], 'имя'), { label: attr(m[1], 'новая'), oldLabel: attr(m[1], 'старая') }])),
    };
}

// Куда ставить память: свой макрос, готовое место для саммари или конец Main. Пресет не меняется.
export function chooseSlot(enabledContents) {
    const text = enabledContents.join('\n');
    if (text.includes('{{pamyat}}')) return 'pamyat';
    if (text.includes('{{summary}}')) return 'summary';
    return 'main';
}

// Суть персонажа: по одному предложению сразу после чата, чтобы модель не забывала, как они говорят.
// Правки анкеты: старый текст меняет код, а не модель, поэтому всё остальное остаётся до буквы.
export function parseHeroEdits(text) {
    const edits = {};
    const add = (name, edit) => { (edits[name] ??= []).push(edit); };
    for (const m of matchAll(text, /<правка\s+([^>]*)>\s*<было>([\s\S]*?)<\/было>\s*<стало>([\s\S]*?)<\/стало>\s*<\/правка>/g)) {
        add(attr(m[1], 'имя'), { from: m[2].trim(), to: cleanDash(m[3]) });
    }
    for (const m of matchAll(text, /<дополнить\s+([^>]*)>([\s\S]*?)<\/дополнить>/g)) {
        add(attr(m[1], 'имя'), { section: attr(m[1], 'раздел'), add: cleanDash(m[2]) });
    }
    return edits;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Модель видит описание с подставленными именами, а в самом описании могут стоять {{char}} и {{user}}:
// имя в цитате находит и макрос, а в новом тексте имя снова становится макросом там, где он был.
export function applyHeroEdits(old, edits = [], names = {}) {
    let text = String(old ?? '');
    const failed = [];
    const macros = Object.entries(names).filter(([, n]) => n).map(([m, n]) => [`{{${m}}}`, n]);
    const loose = (quote) => macros.reduce((re, [macro, n]) => re.split(escapeRe(n)).join(`(?:${escapeRe(n)}|${escapeRe(macro)})`), escapeRe(quote).replace(/\s+/g, '\\s+'));
    // Совпавший кусок с подставленными именами: где начало и конец совпадают с правкой, остаётся исходный текст до буквы.
    const back = (was, now) => {
        if (!macros.length) return now;
        let filled = '';
        const at = [];
        const token = [];
        for (let i = 0, t = 0; i < was.length; t++) {
            const hit = macros.find(([m]) => was.startsWith(m, i));
            const piece = hit ? hit[1] : was[i];
            for (const ch of piece) { filled += ch; at.push(i); token.push(t); }
            i += hit ? hit[0].length : 1;
        }
        at.push(was.length); token.push(-1);
        let p = 0;
        while (p < filled.length && p < now.length && filled[p] === now[p]) p++;
        while (p > 0 && p < filled.length && token[p] === token[p - 1]) p--;
        let s = 0;
        while (s < filled.length - p && s < now.length - p && filled[filled.length - 1 - s] === now[now.length - 1 - s]) s++;
        let cut = filled.length - s;
        while (cut < filled.length && cut > 0 && token[cut] === token[cut - 1]) cut++;
        s = filled.length - cut;
        return was.slice(0, at[p]) + now.slice(p, now.length - s) + was.slice(at[cut]);
    };
    for (const e of edits) {
        if (e.from !== undefined) {
            const re = new RegExp(loose(e.from));
            if (e.from && re.test(text)) text = text.replace(re, (was) => back(was, e.to));
            else failed.push(e.from);
        } else {
            const start = text.search(new RegExp(`^[ \\t]*${escapeRe(e.section)}\\s*:`, 'mi'));
            if (start < 0) {
                failed.push(`${e.section}: ${e.add}`);
                continue;
            }
            const rest = text.slice(start + 1);
            const next = rest.search(/\n\s*[А-ЯЁA-Z][^:\n.]{0,40}:/);
            const end = next < 0 ? text.length : start + 1 + next;
            text = `${text.slice(0, end).trimEnd()} ${e.add}${text.slice(end)}`;
        }
    }
    return { text, failed };
}

export const lostSentences = (old, text, min = 15) => String(old ?? '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > min && !String(text).includes(x));

export function parseEssence(text) {
    return Object.fromEntries(matchAll(text, /<суть\s+([^>]*)>([\s\S]*?)<\/суть>/g).map((m) => [attr(m[1], 'имя'), cleanDash(m[2])]).filter(([name, value]) => name && value));
}

export function essenceBlock(memory, names) {
    const lines = names.map((n) => [n, memory?.essence?.[n]]).filter(([, value]) => value).map(([n, value]) => `${n}: ${value}`);
    return lines.length ? `<суть_персонажа>\n${lines.join('\n')}\n</суть_персонажа>` : '';
}

export const findForbidden = (text) => {
    const low = String(text).toLowerCase();
    return FORBIDDEN.filter((w) => low.includes(w));
};

// Список моделей в любом виде: массив, вложенный data или объект с именами в ключах.
export function modelIds(data, depth = 0) {
    if (data === null || data === undefined || depth > 4) return [];
    if (typeof data === 'string') return [data];
    if (Array.isArray(data)) return data.flatMap((m) => (typeof m === 'string' ? [m] : (typeof (m?.id ?? m?.name ?? m?.model) === 'string' ? [m.id ?? m.name ?? m.model] : []))).map((m) => m.replace(/^models\//, ''));
    if (typeof data !== 'object') return [];
    for (const key of ['data', 'models', 'result', 'list', 'items']) {
        const found = modelIds(typeof data[key] === 'string' ? null : data[key], depth + 1);
        if (found.length) return found;
    }
    const values = Object.values(data);
    const isMap = depth > 0 && values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v));
    return isMap ? Object.keys(data) : [];
}

const isLocalUrl = (url) => {
    try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
    } catch {
        return false;
    }
};

// Какие ключи таверны пробовать для профиля. На чужой адрес не отправляем лишних ключей:
// только ключ профиля, а если его больше нет, активный. Остальные только на свой компьютер.
export function secretCandidates(profile, secrets, url) {
    const list = Array.isArray(secrets) ? secrets : [];
    const own = list.find((k) => k.id === profile['secret-id']);
    if (own) return [own, ...(isLocalUrl(url) ? list.filter((k) => k !== own) : [])];
    const active = list.filter((k) => k.active);
    return isLocalUrl(url) ? [...active, ...list.filter((k) => !k.active)] : active;
}
