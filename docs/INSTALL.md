# In-app installation

The floating install card sits at the end of the login and dashboard views,
needs no portal session, and takes no focus. Its controller starts before React
mounts, so the deferred native event survives login, logout, and navigation.

## Browser behavior

| Environment | Card behavior |
|---|---|
| Android with `beforeinstallprompt` | **Install app** opens the native dialog; the event is consumed once. Failure surfaces as an error, not a dead button. |
| Android without an install event | **How to install** explains the browser-menu fallback. |
| iPhone/iPad Safari in browser mode | Share + Add to Home Screen icons with inline steps ending in the **Add** confirmation. |
| iOS in another browser | Asks the user to switch to Safari first. |
| Standalone (`display-mode: standalone` / `navigator.standalone`) | No card, no reserved space. |
| Accepted prompt or `appinstalled` | Card disappears immediately. |

The card reserves its measured height so footer actions scroll above it, and
hides while the keyboard is open (`visualViewport`) without recording that as a
dismissal.

## Dismissal and APK fallback

- Closing the card or cancelling the native dialog stamps epoch-milliseconds in
  `juet.portal.install.dismissedAt.v1`.
- The cooldown is **14 days**, not permanent; reloads, login, and logout don't
  reset it. An expiry timer and focus/visibility checks handle long-lived tabs;
  storage events sync dismissal across tabs.
- Invalid, expired, or future timestamps don't suppress the card. With storage
  blocked or full, dismissal lasts the page's lifetime. The controller never
  clears session keys.
- **Or download APK** opens
  <https://github.com/jitendradara12/lazyportal/releases> (iOS labels it
  **Android only**), with `noopener noreferrer`.

Reset the cooldown during manual testing:

```js
localStorage.removeItem("juet.portal.install.dismissedAt.v1");
location.reload();
```

## Verification

`npm test` covers the install policy with mocked browsers/storage/clock;
`npm --workspace @juet/web run test:e2e` runs the real app in Chromium/Android
and WebKit/iPhone contexts with portal APIs and install events mocked. The
**Web checks** workflow runs both suites and the production build on PRs and
master; failing browser tests keep traces and screenshots for seven days.

## Real-device checklist

Browser tests cannot exercise the OS install UI. Before release, on an HTTPS
deployment:

1. **Android Chrome, fresh:** tap **Install app** → native dialog appears once →
   accept → confirm Home Screen launch and no card in standalone. Cancel instead
   and confirm the cooldown hides the card.
2. **iPhone/iPad Safari:** share → Add to Home Screen → **Add** → launch the
   icon. No card in standalone, including iPadOS desktop-site mode. iOS Chrome
   must route to Safari.
3. **Layout:** keyboard open, rotated, larger text, guidance expanded — footer
   clears the card, no focus trap, reduced motion respected.
4. **Dismissal:** close → reload → log in/out → second tab stays hidden, session
   untouched. Reset with the snippet above to repeat.
5. **APK link:** Releases page opens in a separate tab and lists the signed APK.
