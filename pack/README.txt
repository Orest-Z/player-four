==================================================================
  PLAYER FOUR  v{version}
  Your phone is the controller.

  Made by Orest-Z  -  https://github.com/Orest-Z
==================================================================

Up to four phones become Xbox controllers on this PC. Nothing to
install on the phones, no account, and nothing online: the phones
talk straight to this PC over your Wi-Fi.


FIRST TIME ON THIS PC
---------------------
1. Install the controller driver, ViGEmBus (only once).
   If it's missing, Player Four shows an "Open the download page"
   button. Or go to:
   https://github.com/nefarius/ViGEmBus/releases/latest
   - Under "Assets", click ViGEmBus_1.22.0_x64_x86_arm64.exe.
   - Open the downloaded file and click through the installer.
     Player Four notices the driver on its own.
   - If Windows SmartScreen warns about the installer, it's safe
     to continue ("More info", then "Run anyway") as long as you
     downloaded it from that GitHub page.
   If you use DS4Windows, you already have the driver.

2. Double-click "Player Four.exe".
   - If Windows says "Windows protected your PC", click
     "More info", then "Run anyway".
   - If Windows asks about network access, allow it on private
     networks, or the phones can't reach this PC.


PLAY
----
1. Put the phones on the same Wi-Fi as this PC.
2. Scan the QR code in the Player Four window with each phone's
   camera.
3. The first time on each phone, the browser warns about the
   connection. It's this PC's own security certificate, which
   phones need before they'll share their tilt sensor:
     Android:  tap "Advanced", then "Proceed".
     iPhone:   tap "Show Details", then "visit this website".
4. Pick a layout: Racing, Party, Retro or Full pad. Then play!

On the phone, Settings lets each player set their name and color.
Android phones shake when the game rumbles the controller.


GOOD TO KNOW
------------
- Closing the window can keep Player Four running in the tray,
  next to the clock. Right-click its icon there to quit.
- Settings and certificates live in %APPDATA%\Player Four.
  Delete that folder to start fresh.
- Games see up to four Xbox 360 controllers. Players are numbered
  in the order they join.


Player Four is free. Source code and updates:
https://github.com/Orest-Z/player-four
