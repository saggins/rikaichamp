import { KanjiResult } from '@birchill/hikibiki-data';

import { serializeTags } from './name-tags';
import { WordEntry, NameEntry } from './query';
import {
  getReferenceValue,
  getSelectedReferenceLabels,
  ReferenceAbbreviation,
} from './refs';

export type Entry =
  | { type: 'word'; data: WordEntry }
  | { type: 'name'; data: NameEntry }
  | { type: 'kanji'; data: KanjiResult };

export function getWordToCopy(entry: Entry): string {
  let result: string;

  switch (entry.type) {
    case 'word':
      result = entry.data.kanjiKana;
      break;

    case 'name':
      result = entry.data.names.map(name => name.kanji || name.kana).join(', ');
      break;

    case 'kanji':
      result = entry.data.c;
      break;
  }

  return result!;
}

export function getEntryToCopy(
  entry: Entry,
  {
    kanjiReferences = [] as Array<ReferenceAbbreviation>,
    showKanjiComponents = true,
  }: {
    kanjiReferences?: Array<ReferenceAbbreviation>;
    showKanjiComponents?: boolean;
  } = {}
): string {
  let result: string;

  switch (entry.type) {
    case 'word':
      result = entry.data.kanjiKana;
      if (entry.data.kana.length) {
        result += ` [${entry.data.kana.join('; ')}]`;
      }
      if (entry.data.romaji.length) {
        result += ` (${entry.data.romaji.join(', ')})`;
      }
      result += ' ' + entry.data.definition;
      break;

    case 'name':
      result = entry.data.names
        .map(name => (name.kanji ? `${name.kanji} [${name.kana}]` : name.kana))
        .join(', ');

      const { text, tags } = entry.data.definition;
      let tagsText = serializeTags(tags);
      if (tagsText) {
        tagsText = `(${tagsText}) `;
      }
      result += ` ${tagsText}${text}`;
      break;

    case 'kanji':
      {
        const { c, r, m, rad, comp } = entry.data;

        result = c;
        const readings = getKanjiReadings(entry.data);
        if (readings) {
          result += ` [${readings}]`;
        }
        if (r.na && r.na.length) {
          result += ` (${r.na.join(`、`)})`;
        }
        result += ` ${m.join(', ')}`;
        const radicalLabel = browser.i18n.getMessage(
          'content_kanji_radical_label'
        );
        result += `; ${radicalLabel}: ${rad.b || rad.k}（${rad.na.join(
          '、'
        )}）`;
        if (rad.base) {
          const baseChar = (rad.base.b || rad.base.k)!;
          const baseReadings = rad.base.na.join('、');
          result +=
            ' ' +
            browser.i18n.getMessage('content_kanji_base_radical', [
              baseChar,
              baseReadings,
            ]);
        }
        if (showKanjiComponents && comp.length) {
          const componentsLabel = browser.i18n.getMessage(
            'content_kanji_components_label'
          );
          let components: Array<string> = [];
          for (const component of comp) {
            components.push(
              `${component.c} (${
                component.na.length ? component.na[0] + ', ' : ''
              }${component.m.length ? component.m[0] : ''})`
            );
          }
          result += `; ${componentsLabel}: ${components.join(', ')}`;
        }

        if (kanjiReferences.length) {
          const labels = getSelectedReferenceLabels(kanjiReferences);
          for (const label of labels) {
            if (
              label.ref === 'nelson_r' &&
              !rad.nelson &&
              kanjiReferences.includes('radical')
            ) {
              continue;
            }
            result += `; ${label.short || label.full} ${getReferenceValue(
              entry.data,
              label.ref
            ) || '-'}`;
          }
        }
      }
      break;
  }

  return result!;
}

export function getFieldsToCopy(
  entry: Entry,
  {
    kanjiReferences = [] as Array<ReferenceAbbreviation>,
    showKanjiComponents = true,
  }: {
    kanjiReferences?: Array<ReferenceAbbreviation>;
    showKanjiComponents?: boolean;
  } = {}
): string {
  let result: string;

  switch (entry.type) {
    case 'word':
      result = entry.data.kanjiKana;
      result += `\t${entry.data.kana.join('; ')}`;
      if (entry.data.romaji.length) {
        result += `\t${entry.data.romaji.join('; ')}`;
      }
      result += `\t${entry.data.definition.replace(/\//g, '; ')}`;
      break;

    case 'name':
      {
        const { text, tags } = entry.data.definition;
        let tagsText = serializeTags(tags);
        if (tagsText) {
          tagsText = `(${tagsText}) `;
        }
        result = entry.data.names
          .map(name => `${name.kanji || ''}\t${name.kana}\t${tagsText}${text}`)
          .join('\n');
      }
      break;

    case 'kanji':
      {
        const { c, r, m, comp } = entry.data;

        result = c;
        const readings = getKanjiReadings(entry.data);
        result += `\t${readings}`;
        result += `\t${(r.na || []).join(`、`)}`;
        result += `\t${m.join(', ')}`;
        if (showKanjiComponents) {
          const components = comp.map(comp => comp.c).join('');
          result += `\t${components}`;
        }
        if (kanjiReferences.length) {
          const labels = getSelectedReferenceLabels(kanjiReferences);
          for (const label of labels) {
            // For some common types we don't produce the label
            switch (label.ref) {
              case 'radical':
              case 'unicode':
              case 'nelson_r':
                // All the above types also either always exist (radical,
                // unicode) or if they don't exist we want to produce an empty
                // value (not '-') hence why we don't include the ... || '-'
                // from the next block.
                result += '\t' + getReferenceValue(entry.data, label.ref);
                break;

              default:
                result += `\t${label.short || label.full} ${getReferenceValue(
                  entry.data,
                  label.ref
                ) || '-'}`;
                break;
            }
          }
        }
      }
      break;
  }

  return result!;
}

function getKanjiReadings(kanji: KanjiResult): string {
  return [
    ...(kanji.r.on ? kanji.r.on : []),
    ...(kanji.r.kun ? kanji.r.kun : []),
  ].join('、');
}
