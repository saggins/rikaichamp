/*

  Rikaichamp
  by Brian Birtles
  https://github.com/birtles/rikaichamp

  ---

  Originally based on Rikaikun
  by Erek Speed
  http://code.google.com/p/rikaikun/

  ---

  Originally based on Rikaichan 1.07
  by Jonathan Zarate
  http://www.polarcloud.com/

  ---

  Originally based on RikaiXUL 0.4 by Todd Rudick
  http://www.rikai.com/
  http://rikaixul.mozdev.org/

  ---

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; either version 2 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, write to the Free Software
  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA

  ---

  Please do not change or remove any of the copyrights or links to web pages
  when modifying any of the files. - Jon

*/

import '../manifest.json.src';
import '../html/background.html.src';

import Bugsnag, { Event as BugsnagEvent } from '@bugsnag/browser';
import {
  DatabaseState,
  JpdictDatabase,
  KanjiResult,
  toUpdateErrorState,
  UpdateErrorState,
  updateWithRetry,
  cancelUpdateWithRetry,
} from '@birchill/hikibiki-data';

import { updateBrowserAction, FlatFileDictState } from './browser-action';
import { Config } from './config';
import { Dictionary } from './data';
import {
  notifyDbStateUpdated,
  DbListenerMessage,
  ResolvedDataVersions,
} from './db-listener-messages';
import { debounce } from './debounce';
import { requestIdleCallbackPromise } from './request-idle-callback';

//
// Minimum amount of time to wait before checking for database updates.
//

const UPDATE_THRESHOLD_MS = 12 * 60 * 60 * 1000; // 12 hours

//
// Setup bugsnag
//

const getExtensionInstallId = (): string => {
  try {
    return new URL(browser.runtime.getURL('yer')).host;
  } catch (e) {
    return 'unknown';
  }
};

let releaseStage = 'production';

browser.management.getSelf().then((info) => {
  if (info.installType === 'development') {
    releaseStage = 'development';
  }
});

const manifest = browser.runtime.getManifest();

const bugsnagClient = Bugsnag.start({
  apiKey: 'e707c9ae84265d122b019103641e6462',
  appVersion: manifest.version_name || manifest.version,
  autoTrackSessions: false,
  collectUserIp: false,
  enabledBreadcrumbTypes: ['log', 'error'],
  logger: null,
  onError: (event: BugsnagEvent) => {
    // Due to Firefox bug 1561911
    // (https://bugzilla.mozilla.org/show_bug.cgi?id=1561911)
    // we can get spurious unhandledrejections when using streams.
    // Until the fix for that bug is in ESR, we filter them out here.
    if (event.errors[0].errorClass === 'DownloadError' && event.unhandled) {
      return false;
    }

    // Fix up grouping
    if (
      event.errors[0].errorClass === 'DownloadError' &&
      event.originalError &&
      typeof event.originalError.url !== 'undefined'
    ) {
      // Group by URL and error code
      event.groupingHash =
        String(event.originalError.code) + event.originalError.url;
      event.request.url = event.originalError.url;
    }

    if (
      event.errors[0].errorClass === 'ExtensionStorageError' &&
      event.originalError
    ) {
      const { key, action } = event.originalError;
      event.groupingHash = `${action}:${key}`;
    }

    // Update release stage here since we can only fetch this async but
    // bugsnag doesn't allow updating the instance after initializing.
    event.app.releaseStage = releaseStage;

    return true;
  },
  user: { id: getExtensionInstallId() },
});

//
// Define error type for better grouping
//

class ExtensionStorageError extends Error {
  key: string;
  action: 'set' | 'get';

  constructor(
    { key, action }: { key: string; action: 'set' | 'get' },
    ...params: any[]
  ) {
    super(...params);
    Object.setPrototypeOf(this, ExtensionStorageError.prototype);

    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, ExtensionStorageError);
    }

    this.name = 'ExtensionStorageError';
    this.message = `Failed to ${action} '${key}'`;
    this.key = key;
    this.action = action;
  }
}

//
// Setup config
//

const config = new Config();

config.addChangeListener((changes) => {
  // Add / remove context menu as needed
  if (changes.hasOwnProperty('contextMenuEnable')) {
    if ((changes as any).contextMenuEnable.newValue) {
      addContextMenu();
    } else {
      removeContextMenu();
    }
  }

  // Update pop-up style as needed
  if (enabled && changes.hasOwnProperty('popupStyle')) {
    const popupStyle = (changes as any).popupStyle.newValue;
    updateBrowserAction({
      popupStyle,
      enabled: true,
      flatFileDictState,
      kanjiDb,
      updateError: lastUpdateError,
    });
  }

  // Update toggle key
  if (
    changes.hasOwnProperty('toggleKey') &&
    typeof (browser.commands as any).update === 'function'
  ) {
    try {
      (browser.commands as any).update({
        name: '_execute_browser_action',
        shortcut: (changes as any).toggleKey.newValue,
      });
    } catch (e) {
      const message = `Failed to update toggle key to ${
        (changes as any).toggleKey.newValue
      }`;
      console.error(message);
      Bugsnag.notify(message, (event) => {
        event.severity = 'warning';
      });
    }
  }

  // Update dictionary language
  if (changes.hasOwnProperty('dictLang')) {
    const newLang = (changes as any).dictLang.newValue;
    Bugsnag.leaveBreadcrumb(
      `Changing language of kanji database to ${newLang}.`
    );

    kanjiDb.setPreferredLang(newLang).then(() => {
      Bugsnag.leaveBreadcrumb(
        `Changed language of kanji database to ${newLang}. Running initial update...`
      );
      return updateKanjiDb();
    });
  }

  // Tell the content scripts about any changes
  //
  // TODO: Ignore changes that aren't part of contentConfig
  updateConfig(config.contentConfig);
});

async function updateConfig(config: ContentConfig) {
  if (!enabled) {
    return;
  }

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });

  for (const win of windows) {
    console.assert(typeof win.tabs !== 'undefined');
    for (const tab of win.tabs!) {
      console.assert(
        typeof tab.id === 'number',
        `Unexpected tab id: ${tab.id}`
      );
      browser.tabs
        .sendMessage(tab.id!, { type: 'enable', config })
        .catch(() => {
          /* Some tabs don't have the content script so just ignore
           * connection failures here. */
        });
    }
  }
}

config.ready.then(() => {
  if (config.contextMenuEnable) {
    addContextMenu();
  }

  // I'm not sure if this can actually happen, but just in case, update the
  // toggleKey command if it differs from what is currently set.
  if (typeof (browser.commands as any).update === 'function') {
    const getToggleCommand = async (): Promise<browser.commands.Command | null> => {
      const commands = await browser.commands.getAll();
      for (const command of commands) {
        if (command.name === '_execute_browser_action') {
          return command;
        }
      }
      return null;
    };

    getToggleCommand().then((command: browser.commands.Command | null) => {
      if (command && command.shortcut !== config.toggleKey) {
        try {
          (browser.commands as any).update({
            name: '_execute_browser_action',
            shortcut: config.toggleKey,
          });
        } catch (e) {
          const message = `On startup, failed to update toggle key to ${config.toggleKey}`;
          console.error(message);
          Bugsnag.notify(message, (event) => {
            event.severity = 'warning';
          });
        }
      }
    });
  }
});

//
// Kanji database
//

// We make sure this is always set to _something_ even if it is an unavailable
// database.
//
// This ensures we don't need to constantly check if it set or not and saves us
// having TWO different states representing an unavailable database. That is:
//
// a) typeof kanjiDb === 'undefined' OR
// b) kanjiDb.state === DatabaseState.Unavailable
//
// By doing this we only ever need to check for (b) and that is also covered
// by the kanjiDbInitialized Promise below which will reject for an unavailable
// database.
let kanjiDb: JpdictDatabase;

// Debounce notifications since often we'll get a notification that the update
// state has been updated quickly followed by a call to updateWithRetry's
// error callback providing the latest error.
const updateDbStatus = debounce(async () => {
  await notifyDbListeners();
  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled,
    flatFileDictState,
    kanjiDb,
    updateError: lastUpdateError,
  });
}, 0);

// This Promise will resolve once we have finished trying to open the database.
// It will reject if the database is unavailable.
let kanjiDbInitialized: Promise<JpdictDatabase>;

initKanjiDb();

function initKanjiDb() {
  kanjiDbInitialized = new Promise(async (resolve, reject) => {
    let retryCount = 0;
    while (true) {
      if (kanjiDb) {
        try {
          await kanjiDb.destroy();
        } catch (e) {
          console.log('Failed to destroy previous database');
        }
      }

      kanjiDb = new JpdictDatabase({ verbose: true });

      kanjiDb.addChangeListener(updateDbStatus);
      kanjiDb.onWarning = (message: string) => {
        Bugsnag.notify(message, (event) => {
          event.severity = 'warning';
        });
      };

      try {
        await kanjiDb.ready;
        resolve(kanjiDb);
        return;
      } catch (e) {
        if (retryCount >= 3) {
          console.log(
            'Giving up opening database. Likely in permanent private browsing mode.'
          );
          reject(e);
          return;
        }
        retryCount++;
        console.log(
          `Failed to open database. Retrying shortly (attempt: ${retryCount})...`
        );
        await requestIdleCallbackPromise({ timeout: 1000 });
      }
    }
  });

  kanjiDbInitialized.catch(() => {
    // Make sure we attach some sort of error handler to this just to avoid
    // spurious unhandledrejections being reported.
  });
}

const dbListeners: Array<browser.runtime.Port> = [];

async function notifyDbListeners(specifiedListener?: browser.runtime.Port) {
  if (!dbListeners.length) {
    return;
  }

  if (
    typeof kanjiDb.dataVersions.kanji === 'undefined' ||
    typeof kanjiDb.dataVersions.radicals === 'undefined'
  ) {
    return;
  }

  const message = notifyDbStateUpdated({
    databaseState: kanjiDb.state,
    updateState: kanjiDb.updateState,
    updateError: lastUpdateError,
    versions: kanjiDb.dataVersions as ResolvedDataVersions,
  });

  // The lastCheck field in the updateState we get back from the database will
  // only be set if we did a check this session. It is _not_ a stored value.
  // So, if it is not set, use the value we store instead.
  if (message.updateState.lastCheck === null) {
    try {
      const getResult = await browser.storage.local.get('lastUpdateKanjiDb');
      if (typeof getResult.lastUpdateKanjiDb === 'number') {
        message.updateState.lastCheck = new Date(getResult.lastUpdateKanjiDb);
      }
    } catch (e) {
      // Extension storage can sometimes randomly fail with 'An unexpected error
      // occurred'. Ignore, but log it.
      Bugsnag.notify(
        new ExtensionStorageError({ key: 'lastUpdateKanjiDb', action: 'get' }),
        (event) => {
          event.severity = 'warning';
        }
      );
    }
  }

  for (const listener of dbListeners) {
    if (specifiedListener && listener !== specifiedListener) {
      continue;
    }

    try {
      listener.postMessage(message);
    } catch (e) {
      console.log('Error posting message');
      console.log(e);
      Bugsnag.notify(e || '(Error posting message update message)');
    }
  }
}

async function maybeDownloadData() {
  try {
    await kanjiDbInitialized;
  } catch (_) {
    return;
  }

  // Set initial language
  await config.ready;
  try {
    Bugsnag.leaveBreadcrumb(
      `Setting initial language of kanji database to ${config.dictLang}.`
    );
    await kanjiDb.setPreferredLang(config.dictLang);
    Bugsnag.leaveBreadcrumb(`Successfully set language to ${config.dictLang}.`);
  } catch (e) {
    console.error(e);
    Bugsnag.notify(e);
  }

  // Even if the database is not empty, check if it needs an update.
  if (kanjiDb.state === DatabaseState.Ok) {
    let lastUpdateKanjiDb: number | null = null;
    try {
      const getResult = await browser.storage.local.get('lastUpdateKanjiDb');
      lastUpdateKanjiDb =
        typeof getResult.lastUpdateKanjiDb === 'number'
          ? getResult.lastUpdateKanjiDb
          : null;
    } catch (e) {
      // Ignore
    }
    Bugsnag.leaveBreadcrumb(`Got last update time of ${lastUpdateKanjiDb}`);

    // If we updated within the minimum window then we're done.
    if (
      lastUpdateKanjiDb &&
      Date.now() - lastUpdateKanjiDb < UPDATE_THRESHOLD_MS
    ) {
      Bugsnag.leaveBreadcrumb('Downloaded data is up-to-date');
      return;
    }
  }

  await updateKanjiDb();
}

let lastUpdateError: UpdateErrorState | undefined;

async function updateKanjiDb({
  forceUpdate = false,
}: { forceUpdate?: boolean } = {}) {
  try {
    await kanjiDbInitialized;
  } catch (_) {
    return;
  }

  updateWithRetry({
    db: kanjiDb,
    forceUpdate,
    onUpdateComplete: async () => {
      Bugsnag.leaveBreadcrumb('Successfully updated kanji database');

      lastUpdateError = undefined;
      updateDbStatus();

      // Extension storage can randomly fail with "An unexpected error occurred".
      try {
        await browser.storage.local.set({
          lastUpdateKanjiDb: new Date().getTime(),
        });
      } catch (e) {
        Bugsnag.notify(
          new ExtensionStorageError({
            key: 'lastUpdateKanjiDb',
            action: 'set',
          }),
          (event) => {
            event.severity = 'warning';
          }
        );
      }
    },
    onUpdateError: (params) => {
      const { error, nextRetry, retryCount } = params;
      if (nextRetry) {
        const diffInMs = nextRetry.getTime() - Date.now();
        Bugsnag.leaveBreadcrumb(
          `Kanji database update encountered ${error.name} error. Retrying in ${diffInMs}ms.`
        );

        // We don't want to report all download errors since the auto-retry
        // behavior will mean we get too many. Also, we don't care about
        // intermittent failures for users on flaky network connections.
        //
        // However, if a lot of clients are failing multiple times to fetch
        // a particular resource, we want to know.
        if (retryCount === 5) {
          Bugsnag.notify(error, (event) => {
            event.severity = 'warning';
          });
        }
      } else if (error.name !== 'AbortError' && error.name !== 'OfflineError') {
        Bugsnag.notify(error);
      } else {
        Bugsnag.leaveBreadcrumb(
          `Kanji database update encountered ${error.name} error`
        );
      }

      lastUpdateError = toUpdateErrorState(params);
      updateDbStatus();
    },
  });
}

browser.runtime.onConnect.addListener((port: browser.runtime.Port) => {
  dbListeners.push(port);
  notifyDbListeners(port);

  port.onMessage.addListener((evt: unknown) => {
    if (!isDbListenerMessage(evt)) {
      return;
    }

    switch (evt.type) {
      case 'updatedb':
        if (kanjiDb.state === DatabaseState.Unavailable) {
          initKanjiDb();
          kanjiDbInitialized
            .then(() => {
              Bugsnag.leaveBreadcrumb('Manually triggering database update');
              maybeDownloadData();
            })
            .catch(() => {
              /* Ignore */
            });
        } else {
          updateKanjiDb({ forceUpdate: true });
        }
        break;

      case 'cancelupdatedb':
        Bugsnag.leaveBreadcrumb('Manually canceling database update');
        cancelUpdateWithRetry(kanjiDb);
        break;

      case 'deletedb':
        Bugsnag.leaveBreadcrumb('Manually deleting database');
        kanjiDb.destroy();
        break;

      case 'reporterror':
        Bugsnag.notify(evt.message);
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    const index = dbListeners.indexOf(port);
    if (index !== -1) {
      dbListeners.splice(index, 1);
    }
  });
});

function isDbListenerMessage(evt: unknown): evt is DbListenerMessage {
  return typeof evt === 'object' && typeof (evt as any).type === 'string';
}

//
// Flat-file (legacy) dictionary
//

let flatFileDict: Dictionary | undefined = undefined;
// TODO: This is temporary until we move the other databases to IDB
let flatFileDictState = FlatFileDictState.Ok;

async function loadDictionary(): Promise<void> {
  if (!flatFileDict) {
    flatFileDict = new Dictionary({ bugsnag: bugsnagClient });
  }

  try {
    flatFileDictState = FlatFileDictState.Loading;
    await flatFileDict.loaded;
  } catch (e) {
    flatFileDictState = FlatFileDictState.Error;
    // If we fail loading the dictionary, make sure to reset it so we can try
    // again!
    flatFileDict = undefined;
    throw e;
  }
  flatFileDictState = FlatFileDictState.Ok;

  Bugsnag.leaveBreadcrumb('Loaded dictionary successfully');
}

//
// Context menu
//

let menuId: number | string | null = null;

function addContextMenu() {
  if (menuId) {
    return;
  }

  try {
    menuId = browser.contextMenus.create({
      id: 'context-toggle',
      type: 'checkbox',
      title: browser.i18n.getMessage('menu_enable_extension'),
      command: '_execute_browser_action',
      contexts: ['all'],
      checked: enabled,
    });
  } catch (e) {
    // TODO: Chrome doesn't support the 'command' member so if we got an
    // exception, assume that's it and try the old-fashioned way.
  }
}

async function removeContextMenu() {
  if (!menuId) {
    return;
  }

  try {
    await browser.contextMenus.remove(menuId);
  } catch (e) {
    console.error(`Failed to remove context menu: ${e}`);
    Bugsnag.notify(`Failed to remove context menu: ${e}`, (event) => {
      event.severity = 'warning';
    });
  }

  menuId = null;
}

//
// Tab toggling
//

let enabled: boolean = false;

async function enableTab(tab: browser.tabs.Tab) {
  console.assert(typeof tab.id === 'number', `Unexpected tab ID: ${tab.id}`);

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled: true,
    flatFileDictState: FlatFileDictState.Loading,
    kanjiDb,
    updateError: lastUpdateError,
  });

  if (menuId) {
    browser.contextMenus.update(menuId, { checked: true });
  }

  try {
    await Promise.all([loadDictionary(), config.ready]);

    // Trigger download but don't wait on it. We don't block on this because
    // we currently only download the kanji data and we don't need it to be
    // downloaded before we can do something useful.
    Bugsnag.leaveBreadcrumb('Triggering database update from enableTab...');
    maybeDownloadData().then(() => {
      Bugsnag.leaveBreadcrumb(
        'Finished triggering database update from enableTab'
      );
    });

    // Send message to current tab to add listeners and create stuff
    browser.tabs
      .sendMessage(tab.id!, {
        type: 'enable',
        config: config.contentConfig,
      })
      .catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
    enabled = true;
    browser.storage.local.set({ enabled: true }).catch(() => {
      Bugsnag.notify(
        new ExtensionStorageError({ key: 'enabled', action: 'set' }),
        (event) => {
          event.severity = 'warning';
        }
      );
    });

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      flatFileDictState,
      kanjiDb,
      updateError: lastUpdateError,
    });
  } catch (e) {
    Bugsnag.notify(e || '(No error)');

    updateBrowserAction({
      popupStyle: config.popupStyle,
      enabled: true,
      flatFileDictState,
      kanjiDb,
      updateError: lastUpdateError,
    });

    // Reset internal state so we can try again
    flatFileDict = undefined;

    if (menuId) {
      browser.contextMenus.update(menuId, { checked: false });
    }
  }
}

async function disableAll() {
  enabled = false;

  browser.storage.local.remove('enabled').catch(() => {
    /* Ignore */
  });

  browser.browserAction.setTitle({
    title: browser.i18n.getMessage('command_toggle_disabled'),
  });

  updateBrowserAction({
    popupStyle: config.popupStyle,
    enabled,
    flatFileDictState,
    kanjiDb,
    updateError: lastUpdateError,
  });

  if (menuId) {
    browser.contextMenus.update(menuId, { checked: false });
  }

  const windows = await browser.windows.getAll({
    populate: true,
    windowTypes: ['normal'],
  });
  for (const win of windows) {
    console.assert(typeof win.tabs !== 'undefined');
    for (const tab of win.tabs!) {
      console.assert(
        typeof tab.id === 'number',
        `Unexpected tab id: ${tab.id}`
      );
      browser.tabs.sendMessage(tab.id!, { type: 'disable' }).catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
    }
  }
}

function toggle(tab: browser.tabs.Tab) {
  if (enabled) {
    disableAll();
  } else {
    Bugsnag.leaveBreadcrumb('Enabling tab from toggle');
    enableTab(tab);
  }
}

//
// Search
//

let dictCount: number = 3;
let kanjiDictIndex: number = 1;
let nameDictIndex: number = 2;
let showIndex: number = 0;

function search(text: string, dictOption: DictMode) {
  if (!flatFileDict) {
    console.error('Dictionary not initialized in search');
    Bugsnag.notify('Dictionary not initialized in search', (event) => {
      event.severity = 'warning';
    });
    return;
  }

  switch (dictOption) {
    case DictMode.ForceKanji:
      return searchKanji(text.charAt(0));

    case DictMode.Default:
      showIndex = 0;
      break;

    case DictMode.NextDict:
      showIndex = (showIndex + 1) % dictCount;
      break;
  }

  const searchCurrentDict: (text: string) => Promise<SearchResult | null> = (
    text: string
  ) => {
    switch (showIndex) {
      case kanjiDictIndex:
        return searchKanji(text.charAt(0));
      case nameDictIndex:
        return flatFileDict!.wordSearch({
          input: text,
          doNames: true,
          includeRomaji: false,
        });
    }
    return flatFileDict!.wordSearch({
      input: text,
      doNames: false,
      includeRomaji: config.showRomaji,
    });
  };

  const originalMode = showIndex;
  return (function loopOverDictionaries(text): Promise<SearchResult | null> {
    return searchCurrentDict(text).then((result) => {
      if (result) {
        return result;
      }
      showIndex = (showIndex + 1) % dictCount;
      if (showIndex === originalMode) {
        return null;
      }
      return loopOverDictionaries(text);
    });
  })(text);
}

async function searchKanji(kanji: string): Promise<KanjiResult | null> {
  // Pre-check (might not be needed anymore)
  const codepoint = kanji.charCodeAt(0);
  if (codepoint < 0x3000) {
    return null;
  }

  try {
    await kanjiDbInitialized;
  } catch (_) {
    return null;
  }

  if (kanjiDb.state === DatabaseState.Empty) {
    return null;
  }

  let result;
  try {
    result = await kanjiDb.getKanji([kanji]);
  } catch (e) {
    console.error(e);
    Bugsnag.notify(e || '(Error looking up kanji)');
    return null;
  }

  if (!result.length) {
    return null;
  }

  if (result.length > 1) {
    Bugsnag.notify(`Got more than one result for ${kanji}`, (event) => {
      event.severity = 'warning';
    });
  }

  return result[0];
}

//
// Browser event handlers
//

browser.tabs.onActivated.addListener((activeInfo) => {
  onTabSelect(activeInfo.tabId);
});

browser.browserAction.onClicked.addListener(toggle);

browser.runtime.onMessage.addListener(
  (
    request: any,
    sender: browser.runtime.MessageSender
  ): void | Promise<any> => {
    if (typeof request.type !== 'string') {
      return;
    }

    switch (request.type) {
      case 'enable?':
        if (sender.tab && typeof sender.tab.id === 'number') {
          onTabSelect(sender.tab.id);
        } else {
          console.error('No sender tab in enable? request');
          Bugsnag.leaveBreadcrumb('No sender tab in enable? request');
        }
        break;

      case 'xsearch':
        if (
          typeof request.text === 'string' &&
          typeof request.dictOption === 'number'
        ) {
          return search(request.text as string, request.dictOption as DictMode);
        }
        console.error(
          `Unrecognized xsearch request: ${JSON.stringify(request)}`
        );
        Bugsnag.notify(
          `Unrecognized xsearch request: ${JSON.stringify(request)}`,
          (event) => {
            event.severity = 'warning';
          }
        );
        break;

      case 'translate':
        if (flatFileDict) {
          return flatFileDict.translate({
            text: request.title,
            includeRomaji: config.showRomaji,
          });
        }
        console.error('Dictionary not initialized in translate request');
        Bugsnag.notify(
          'Dictionary not initialized in translate request',
          (event) => {
            event.severity = 'warning';
          }
        );
        break;

      case 'toggleDefinition':
        config.toggleReadingOnly();
        break;

      case 'reportWarning':
        console.assert(
          typeof request.message === 'string',
          '`message` should be a string'
        );
        Bugsnag.notify(request.message, (event) => {
          event.severity = 'warning';
        });
        break;
    }
  }
);

function onTabSelect(tabId: number) {
  if (!enabled) {
    return;
  }

  config.ready.then(() => {
    browser.tabs
      .sendMessage(tabId, {
        type: 'enable',
        config: config.contentConfig,
      })
      .catch(() => {
        /* Some tabs don't have the content script so just ignore
         * connection failures here. */
      });
  });
}

browser.runtime.onInstalled.addListener(async () => {
  Bugsnag.leaveBreadcrumb('Running maybeDownloadData from onInstalled...');
  await maybeDownloadData();
  Bugsnag.leaveBreadcrumb(
    'Finished running maybeDownloadData from onInstalled'
  );
});

browser.runtime.onStartup.addListener(async () => {
  Bugsnag.leaveBreadcrumb('Running maybeDownloadData from onStartup...');
  await maybeDownloadData();
  Bugsnag.leaveBreadcrumb('Finished running maybeDownloadData from onStartup');
});

// See if we were enabled on the last run
//
// We don't do this in onStartup because that won't run when the add-on is
// reloaded and we want to re-enable ourselves in that case too.
(async function () {
  let getEnabledResult;
  try {
    getEnabledResult = await browser.storage.local.get('enabled');
  } catch (e) {
    // If extension storage fails. Just ignore.
    Bugsnag.notify(
      new ExtensionStorageError({ key: 'enabled', action: 'get' }),
      (event) => {
        event.severity = 'warning';
      }
    );
    return;
  }
  const wasEnabled =
    getEnabledResult &&
    getEnabledResult.hasOwnProperty('enabled') &&
    getEnabledResult.enabled;

  if (wasEnabled) {
    const tabs = await browser.tabs.query({
      currentWindow: true,
      active: true,
    });
    if (tabs && tabs.length) {
      Bugsnag.leaveBreadcrumb(
        'Loading because we were enabled on the previous run'
      );
      enableTab(tabs[0]);
    }
  }
})();
