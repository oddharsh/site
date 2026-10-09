#!/usr/bin/env bash
# macOS defaults from https://aadhar.sh/dotfiles
# Generated from the checklist on that page. Each line below is one
# `defaults write`; the tail restarts what has to restart to read it.
set -euo pipefail

# The System rows run as root. Ask for the password now, before any write.
sudo -v

# ── Keyboard ────────────────────────────────────────────────────
# Fastest key repeat (factory: 6)
#   System Settings stops at 2. This is that floor.
defaults write NSGlobalDomain KeyRepeat -int 2

# Shortest delay until repeat (factory: 25)
defaults write NSGlobalDomain InitialKeyRepeat -int 15

# Hold a key to repeat it, never the accent popup (factory: true)
defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

# Straight quotes and dashes, no smart substitution (factory: true)
defaults write NSGlobalDomain NSAutomaticQuoteSubstitutionEnabled -bool false
defaults write NSGlobalDomain NSAutomaticDashSubstitutionEnabled -bool false

# Globe key switches input source
#   0 nothing, 1 input source, 2 emoji, 3 dictation. Set here because Tamil is the second input.
defaults write com.apple.HIToolbox AppleFnUsageType -int 1

# Free Cmd+Space from Spotlight (factory: enabled)
#   Hotkey 64 is Spotlight search. Off here because Raycast takes the chord. Search still opens from the menu bar.
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 64 '{ enabled = 0; value = { parameters = (32, 49, 1048576); type = standard; }; }'

# Switch input source on Opt+Cmd+Space, Ctrl+Space freed (factory: Ctrl+Space / Ctrl+Opt+Space)
#   60 is previous source, 61 is next. 65 is Finder search, which used to own Opt+Cmd+Space.
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 60 '{ enabled = 0; value = { parameters = (32, 49, 1048576); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 61 '{ enabled = 1; value = { parameters = (32, 49, 1572864); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 65 '{ enabled = 0; value = { parameters = (65535, 49, 1572864); type = standard; }; }'

# Plain Ctrl-arrows go to the terminal; Spaces move to Ctrl+Shift
#   32/33 Mission Control and App Exposé off, 34 Mission Control on Ctrl+Shift+Up, 79/81 move a Space on Ctrl+Shift+Left/Right, 80/82 their slow variants off, 35/36/37 off.
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 32 '{ enabled = 0; value = { parameters = (65535, 126, 10747904); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 33 '{ enabled = 0; value = { parameters = (65535, 125, 8650752); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 34 '{ enabled = 1; value = { parameters = (65535, 126, 10878976); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 35 '{ enabled = 0; value = { parameters = (65535, 125, 8781824); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 36 '{ enabled = 0; value = { parameters = (65535, 125, 11010048); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 37 '{ enabled = 0; value = { parameters = (65535, 125, 11141120); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 79 '{ enabled = 1; value = { parameters = (65535, 123, 10878976); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 80 '{ enabled = 0; value = { parameters = (65535, 123, 8781824); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 81 '{ enabled = 1; value = { parameters = (65535, 124, 10878976); type = standard; }; }'
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 82 '{ enabled = 0; value = { parameters = (65535, 124, 8781824); type = standard; }; }'

# Cmd+? leaves the Help menu search alone (factory: on)
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 98 '{ enabled = 0; value = { parameters = (47, 44, 1179648); type = standard; }; }'

# Opt+Cmd+D leaves Dock hiding alone (factory: on)
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 52 '{ enabled = 0; value = { parameters = (100, 2, 1572864); type = standard; }; }'

# ── Trackpad & mouse ────────────────────────────────────────────
# Tap to click (factory: off)
#   Three writes: the built-in trackpad, a Bluetooth one, and the per-host key the login screen reads.
defaults write com.apple.AppleMultitouchTrackpad Clicking -bool true
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad Clicking -bool true
defaults -currentHost write NSGlobalDomain com.apple.mouse.tapBehavior -int 1

# Three-finger drag (factory: off)
#   Lives under Accessibility, Pointer Control. Enabling it moves the space-switch swipe to four fingers, which is what the last four lines do.
defaults write com.apple.AppleMultitouchTrackpad TrackpadThreeFingerDrag -bool true
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadThreeFingerDrag -bool true
defaults -currentHost write NSGlobalDomain com.apple.trackpad.threeFingerDragGesture -int 1
defaults write com.apple.AppleMultitouchTrackpad TrackpadThreeFingerHorizSwipeGesture -int 0
defaults write com.apple.AppleMultitouchTrackpad TrackpadFourFingerHorizSwipeGesture -int 2
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadThreeFingerHorizSwipeGesture -int 0
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadFourFingerHorizSwipeGesture -int 2

# Tracking speed all the way up
#   3 is the right end of the slider.
defaults write NSGlobalDomain com.apple.trackpad.scaling -float 3

# Firm click (factory: medium)
#   0 light, 1 medium, 2 firm. The first key is the click, the second the force click.
defaults write com.apple.AppleMultitouchTrackpad FirstClickThreshold -int 2
defaults write com.apple.AppleMultitouchTrackpad SecondClickThreshold -int 2

# No thumb-and-three-finger spread for Show Desktop (factory: on)
defaults write com.apple.dock showDesktopGestureEnabled -bool false

# Magic Mouse right-click (factory: OneButton)
defaults write com.apple.AppleMultitouchMouse MouseButtonMode -string 'TwoButton'
defaults write com.apple.driver.AppleBluetoothMultitouch.mouse MouseButtonMode -string 'TwoButton'

# ── Appearance ──────────────────────────────────────────────────
# Dark mode (factory: Light)
#   To go back: defaults delete NSGlobalDomain AppleInterfaceStyle. There is no Light value, only the absence of Dark.
defaults write NSGlobalDomain AppleInterfaceStyle -string 'Dark'

# Dark icon and widget style (macOS 26)
defaults write NSGlobalDomain AppleIconAppearanceTheme -string 'RegularDark'

# No glass tint (macOS 26)
defaults write NSGlobalDomain NSGlassTintAmount -int 0

# No icons in menu items (macOS 26) (factory: true)
#   No switch for this in System Settings. Apps read it when they launch.
defaults write NSGlobalDomain NSMenuEnableActionImages -bool false

# Scroll bars only while scrolling (factory: Automatic)
defaults write NSGlobalDomain AppleShowScrollBars -string 'WhenScrolling'

# Click in the scroll bar jumps to that spot (factory: next page)
defaults write NSGlobalDomain AppleScrollerPagingBehavior -bool true

# Light font smoothing
#   No switch for this in System Settings any more. 0 off, 1 light, 2 medium.
defaults write NSGlobalDomain AppleFontSmoothing -int 1

# No animated focus ring
#   No switch in System Settings.
defaults write NSGlobalDomain NSUseAnimatedFocusRing -bool false

# Weeks start on Monday (factory: Sunday, for en_US)
defaults write NSGlobalDomain AppleFirstWeekday -dict gregorian -int 2

# ── Accessibility ───────────────────────────────────────────────
# Reduce transparency, increase contrast, button shapes (factory: all off)
#   Writes to this domain fail unless Terminal has Full Disk Access. The script carries on without them and says so at the end.
defaults write com.apple.universalaccess reduceTransparency -bool true || no_fda=1
defaults write com.apple.universalaccess increaseContrast -bool true || no_fda=1
defaults write com.apple.universalaccess showToolbarButtonShapes -bool true || no_fda=1

# Orange pointer, white outline (factory: black, white)
defaults write com.apple.universalaccess cursorIsCustomized -bool true || no_fda=1
defaults write com.apple.universalaccess cursorFill -dict red -float 1 green -float 0.5763723254 blue -float 0 alpha -float 1 || no_fda=1
defaults write com.apple.universalaccess cursorOutline -dict red -float 1 green -float 1 blue -float 1 alpha -float 1 || no_fda=1

# Smallest text size system-wide (factory: default)
#   Accessibility > Display > Text Size. This sets the global size only; my Mail, Messages, Notes and Calendar stay pinned at M.
defaults write com.apple.universalaccess FontSizeCategory -dict-add global -string 'XS' || no_fda=1

# ── Dock ────────────────────────────────────────────────────────
# Hide the Dock (factory: shown)
defaults write com.apple.dock autohide -bool true

# Show it instantly, no delay and no slide
#   No switch for either in System Settings. This is the pair that proves a Mac was once scripted.
defaults write com.apple.dock autohide-delay -float 0
defaults write com.apple.dock autohide-time-modifier -float 0

# Tiny Dock, big magnification
#   24px tiles, 61px under the cursor.
defaults write com.apple.dock tilesize -int 24
defaults write com.apple.dock magnification -bool true
defaults write com.apple.dock largesize -int 61

# Group windows by app in Mission Control
defaults write com.apple.dock expose-group-apps -bool true

# No bouncing icons
#   No switch in System Settings. Covers both launch and attention bounces.
defaults write com.apple.dock no-bouncing -bool true

# No launch animation (factory: true)
defaults write com.apple.dock launchanim -bool false

# Minimize with Suck
#   The third effect, hidden since Tiger. Genie and Scale are the two in System Settings.
defaults write com.apple.dock mineffect -string 'suck'

# Hidden apps look hidden
#   Translucent Dock icons for apps hidden with Cmd+H. No switch in System Settings.
defaults write com.apple.dock showhidden -bool true

# No recent apps in the Dock (factory: true)
defaults write com.apple.dock show-recents -bool false

# Don't rearrange Spaces by recent use (factory: true)
defaults write com.apple.dock mru-spaces -bool false

# Scroll up on a Dock icon to see that app's windows
#   No switch in System Settings.
defaults write com.apple.dock scroll-to-open -bool true

# Highlight under the cursor in grid stacks
defaults write com.apple.dock mouse-over-hilite-stack -bool true

# Spring-loading on every Dock item (factory: folders only)
defaults write com.apple.dock enable-spring-load-actions-on-all-items -bool true

# Faster Mission Control animation
defaults write com.apple.dock expose-animation-duration -float 0.1

# No hot corners (factory: Quick Note, bottom right)
#   1 is "no action".
defaults write com.apple.dock wvous-tl-corner -int 1
defaults write com.apple.dock wvous-tr-corner -int 1
defaults write com.apple.dock wvous-bl-corner -int 1
defaults write com.apple.dock wvous-br-corner -int 1

# ── Windows ─────────────────────────────────────────────────────
# Stage Manager off
defaults write com.apple.WindowManager GloballyEnabled -bool false

# No gaps between tiled windows (factory: true)
defaults write com.apple.WindowManager EnableTiledWindowMargins -bool false

# Clicking the wallpaper does nothing (factory: true)
#   Sonoma made a click on the desktop hide every window. This puts it back.
defaults write com.apple.WindowManager EnableStandardClickToShowDesktop -bool false

# Reopen an app's windows after quitting it
defaults write NSGlobalDomain NSQuitAlwaysKeepsWindows -bool true

# Always open documents as tabs (factory: fullscreen only)
defaults write NSGlobalDomain AppleWindowTabbingMode -string 'always'

# Double-clicking a title bar does nothing (factory: Zoom)
defaults write NSGlobalDomain AppleActionOnDoubleClick -string 'None'

# Near-instant window resize animation (factory: 0.2)
defaults write NSGlobalDomain NSWindowResizeTime -float 0.001

# Ctrl+Cmd-drag anywhere in a window to move it
#   No switch in System Settings. The Linux alt-drag, on a Mac.
defaults write NSGlobalDomain NSWindowShouldDragOnGesture -bool true

# Ask to keep changes when closing documents (factory: false)
defaults write NSGlobalDomain NSCloseAlwaysConfirmsChanges -bool true

# Five recent items (factory: 10)
defaults write NSGlobalDomain NSRecentDocumentsLimit -int 5

# ── Screenshots ─────────────────────────────────────────────────
# Screenshots go to the clipboard (factory: file on the Desktop)
defaults write com.apple.screencapture target -string 'clipboard'

# Capture in SDR, never HDR
defaults write com.apple.screencapture captureHDR -bool false

# No shadow on window captures (factory: shadow)
defaults write com.apple.screencapture disable-shadow -bool true

# Save as HEIC (factory: png)
defaults write com.apple.screencapture type -string 'heic'

# Include the pointer (factory: false)
defaults write com.apple.screencapture showsCursor -bool true

# ── Menu bar ────────────────────────────────────────────────────
# Clock shows seconds (factory: false)
defaults write com.apple.menuextra.clock ShowSeconds -bool true

# Clock hides AM/PM
defaults write com.apple.menuextra.clock ShowAMPM -bool false

# Battery percentage (factory: hidden)
defaults -currentHost write com.apple.controlcenter BatteryShowPercentage -bool true

# Spotlight icon out of the menu bar
#   Raycast has Cmd+Space, so the icon is dead weight.
defaults -currentHost write com.apple.Spotlight MenuItemHidden -bool true

# ── Spotlight ───────────────────────────────────────────────────
# Clipboard history, kept 8 hours (macOS 26) (factory: off)
#   28800 seconds. The other choices in System Settings are 30 minutes and 7 days.
defaults write com.apple.Spotlight PasteboardHistoryEnabled -bool true
defaults write com.apple.Spotlight PasteboardHistoryTimeout -int 28800

# ── Sound ───────────────────────────────────────────────────────
# Interface sound effects off (factory: on)
defaults write NSGlobalDomain com.apple.sound.uiaudio.enabled -int 0

# Alert sound is Glass
defaults write NSGlobalDomain com.apple.sound.beep.sound -string '/System/Library/Sounds/Glass.aiff'

# ── Finder ──────────────────────────────────────────────────────
# List view by default (factory: icons)
#   Nlsv is list. icnv icons, clmv columns, glyv gallery.
defaults write com.apple.finder FXPreferredViewStyle -string 'Nlsv'

# New windows open at home (factory: Recents)
#   PfHm is home. PfDe Desktop, PfDo Documents, PfAF Recents.
defaults write com.apple.finder NewWindowTarget -string 'PfHm'

# Internal drive off the desktop, externals stay
defaults write com.apple.finder ShowHardDrivesOnDesktop -bool false
defaults write com.apple.finder ShowExternalHardDrivesOnDesktop -bool true
defaults write com.apple.finder ShowRemovableMediaOnDesktop -bool true

# No Finder animations
#   No switch in System Settings. Get Info panes too.
defaults write com.apple.finder DisableAllAnimations -bool true
defaults write com.apple.finder AnimateInfoPanes -bool false

# Cmd+Q quits Finder
#   Adds Quit Finder to its menu. The desktop goes empty until you click the Dock icon.
defaults write com.apple.finder QuitMenuItem -bool true

# Search the current folder (factory: This Mac)
#   SCcf current folder, SCev This Mac, SCsp previous scope.
defaults write com.apple.finder FXDefaultSearchScope -string 'SCcf'

# No warning when changing an extension (factory: true)
defaults write com.apple.finder FXEnableExtensionChangeWarning -bool false

# No warning before emptying the Trash (factory: true)
defaults write com.apple.finder WarnOnEmptyTrash -bool false

# Empty Trash items after 30 days (factory: false)
defaults write com.apple.finder FXRemoveOldTrashItems -bool true

# No Recent Tags in the sidebar (factory: true)
defaults write com.apple.finder ShowRecentTags -bool false

# No .DS_Store on network shares or USB drives
#   No switch in System Settings.
defaults write com.apple.desktopservices DSDontWriteNetworkStores -bool true
defaults write com.apple.desktopservices DSDontWriteUSBStores -bool true

# ── Disk images & drives ────────────────────────────────────────
# Skip disk image verification
defaults write com.apple.frameworks.diskimages skip-verify -bool true
defaults write com.apple.frameworks.diskimages skip-verify-locked -bool true
defaults write com.apple.frameworks.diskimages skip-verify-remote -bool true

# Open a Finder window when a disk image mounts
defaults write com.apple.frameworks.diskimages auto-open-ro-root -bool true
defaults write com.apple.frameworks.diskimages auto-open-rw-root -bool true

# Time Machine stops asking about every new drive
defaults write com.apple.TimeMachine DoNotOfferNewDisksForBackup -bool true

# ── Sharing ─────────────────────────────────────────────────────
# AirPlay Receiver off (factory: on)
#   Frees ports 5000 and 7000 for local dev servers.
defaults -currentHost write com.apple.controlcenter AirplayRecieverEnabled -bool false

# ── Crashes ─────────────────────────────────────────────────────
# Developer crash dialog, delivered as a notification
#   DialogType developer shows the full report. UseUNC moves it into Notification Center.
defaults write com.apple.CrashReporter DialogType -string 'developer'
defaults write com.apple.CrashReporter UseUNC -bool true

# ── Power button ────────────────────────────────────────────────
# Tapping the power button doesn't sleep the Mac
#   Without this, a Touch ID tap sleeps the machine.
defaults write com.apple.loginwindow PowerButtonSleepsSystem -bool false

# ── Screen saver ────────────────────────────────────────────────
# Start after 5 minutes (factory: 20 minutes)
defaults -currentHost write com.apple.screensaver idleTime -int 300

# ── Apps ────────────────────────────────────────────────────────
# Terminal: focus follows the mouse
#   No switch in Terminal's settings. Hovering a window focuses it without raising it.
defaults write com.apple.Terminal FocusFollowsMouse -bool true

# Activity Monitor: CPU graph in the Dock icon
defaults write com.apple.ActivityMonitor IconType -int 5

# Disk Utility: Debug menu, advanced image options, APFS snapshots
defaults write com.apple.DiskUtility DUDebugMenuEnabled -bool true
defaults write com.apple.DiskUtility advanced-image-options -bool true
defaults write com.apple.DiskUtility WorkspaceShowAPFSSnapshots -bool true

# Music: 7-second crossfade, lossless imports
defaults write com.apple.Music crossfadeEnabled -bool true
defaults write com.apple.Music crossfadeSeconds -int 7
defaults write com.apple.Music encoderName -string 'Lossless Encoder'

# ── System (sudo) ───────────────────────────────────────────────
# No startup chime
sudo nvram StartupMute=%01

# Firewall on, stealth mode on (factory: both off)
#   Stealth mode leaves pings and port probes unanswered.
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on

# Never sleep; Low Power Mode on battery
#   On battery the display still sleeps after 10 minutes.
sudo pmset -a sleep 0
sudo pmset -b lowpowermode 1
sudo pmset -b displaysleep 10

# ── apply ───────────────────────────────────────────────────────
killall Dock Finder SystemUIServer ControlCenter 2>/dev/null || true
/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
[ -z "${no_fda:-}" ] || echo 'skipped the accessibility rows: give Terminal Full Disk Access in Privacy & Security, then run this again'
echo 'log out and back in for the rest: keyboard, trackpad & mouse, appearance, accessibility, windows, menu bar, spotlight, sound, sharing, power button'
echo 'relaunch Terminal, Activity Monitor, Disk Utility, Music'
