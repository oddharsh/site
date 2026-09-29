#!/usr/bin/env bash
# macOS defaults from https://aadhar.sh/dotfiles
# Generated from the checklist on that page. Each line below is one
# `defaults write`; the tail restarts what has to restart to read it.
set -euo pipefail

# ── Keyboard ────────────────────────────────────────────────────
# Fastest key repeat (factory: 6)
#   System Settings stops at 2. This is that floor.
defaults write NSGlobalDomain KeyRepeat -int 2

# Shortest delay until repeat (factory: 25)
defaults write NSGlobalDomain InitialKeyRepeat -int 15

# Hold a key to repeat it, never the accent popup (factory: true)
defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false

# Free Cmd+Space from Spotlight (factory: enabled)
#   Hotkey 64 is Spotlight search. Off here because Raycast takes the chord. Search still opens from the menu bar.
defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 64 '{ enabled = 0; value = { parameters = (32, 49, 1048576); type = standard; }; }'

# ── Trackpad ────────────────────────────────────────────────────
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

# ── Screenshots ─────────────────────────────────────────────────
# Screenshots go to the clipboard (factory: file on the Desktop)
defaults write com.apple.screencapture target -string 'clipboard'

# Capture in SDR, never HDR
defaults write com.apple.screencapture captureHDR -bool false

# ── Menu bar ────────────────────────────────────────────────────
# Clock shows seconds (factory: false)
defaults write com.apple.menuextra.clock ShowSeconds -bool true

# Clock hides AM/PM
defaults write com.apple.menuextra.clock ShowAMPM -bool false

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

# ── Screen saver ────────────────────────────────────────────────
# Start after 5 minutes (factory: 20 minutes)
defaults -currentHost write com.apple.screensaver idleTime -int 300

# ── apply ───────────────────────────────────────────────────────
killall Dock Finder SystemUIServer ControlCenter 2>/dev/null || true
/System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
echo 'log out and back in for the rest: keyboard, trackpad, appearance, windows, sound'
