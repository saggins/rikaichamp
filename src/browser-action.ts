import {
  DatabaseState,
  UpdateErrorState,
  UpdateState,
} from '@birchill/hikibiki-data';

// We will eventually drop this once we move everything to IDB
export const enum FlatFileDictState {
  Ok,
  Loading,
  Error,
}

interface BrowserActionState {
  popupStyle: string;
  enabled: boolean;
  flatFileDictState: FlatFileDictState;
  kanjiDb: { state: DatabaseState; updateState: UpdateState };
  updateError?: UpdateErrorState;
}

export function updateBrowserAction({
  popupStyle,
  enabled,
  flatFileDictState,
  kanjiDb,
  updateError,
}: BrowserActionState) {
  let iconFilename = 'disabled';
  let titleStringId = 'command_toggle_disabled';

  // First choose the base icon type / text
  if (enabled) {
    switch (flatFileDictState) {
      case FlatFileDictState.Ok:
        iconFilename = popupStyle;
        titleStringId = 'command_toggle_enabled';
        break;

      case FlatFileDictState.Loading:
        iconFilename = 'loading';
        titleStringId = 'command_toggle_loading';
        break;

      case FlatFileDictState.Error:
        iconFilename = 'error';
        titleStringId = 'error_loading_dictionary';
        break;
    }
  }

  // Next determine if we need to overlay any additional information.
  switch (kanjiDb.updateState.state) {
    case 'checking':
      // Technically the '-indeterminate' icon would be more correct here but
      // using '-0' instead leads to less flicker.
      iconFilename += '-0';
      titleStringId = 'command_toggle_checking';
      break;

    case 'downloading':
      // We only have progress variants for the Ok, disabled, and loading styles.
      if ([popupStyle, 'disabled', 'loading'].includes(iconFilename)) {
        iconFilename += '-' + Math.round(kanjiDb.updateState.progress * 5) * 20;
      }
      titleStringId = 'command_toggle_downloading';
      break;

    case 'updatingdb':
      iconFilename += '-indeterminate';
      titleStringId = 'command_toggle_updating';
      break;
  }

  // Set the icon
  browser.browserAction
    .setIcon({
      path: `images/rikaichamp-${iconFilename}.svg`,
    })
    .catch(() => {
      // Assume we're on Chrome and it still can't handle SVGs
      //
      // If we're loading then, well, that's an animated file for which we only
      // have an SVG version so we should use the disabled variant instead.
      if (iconFilename.startsWith('loading')) {
        iconFilename = iconFilename.replace('loading', 'disabled');
      }
      browser.browserAction.setIcon({
        path: {
          16: `images/rikaichamp-${iconFilename}-16.png`,
          32: `images/rikaichamp-${iconFilename}-32.png`,
          48: `images/rikaichamp-${iconFilename}-48.png`,
        },
      });
    });

  // Add a warning overlay and update the string if there was a fatal
  // update error.
  if (
    kanjiDb.state !== DatabaseState.Ok &&
    !!updateError &&
    updateError.name !== 'AbortError'
  ) {
    browser.browserAction.setBadgeText({ text: '!' });
    browser.browserAction.setBadgeBackgroundColor({ color: 'yellow' });
    titleStringId = 'command_toggle_update_error';
  } else {
    browser.browserAction.setBadgeText({ text: '' });
  }

  // Set the caption
  browser.browserAction.setTitle({
    title: browser.i18n.getMessage(titleStringId),
  });
}
