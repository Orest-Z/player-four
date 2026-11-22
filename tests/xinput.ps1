# Reads the four XInput controllers the way games do, one line each.
# usage: xinput.ps1                     print every controller's state
#        xinput.ps1 rumble <left:right:ms> ...   rumble controller 1 like a game would: each step
#                                                sets the motors (0-65535) and holds them for ms.
# Windows stops a controller's rumble when the program that started it exits, so this one waits.
param([string]$Action)
Add-Type @"
using System.Runtime.InteropServices;
public static class XI {
  [StructLayout(LayoutKind.Sequential)]
  public struct State { public uint Packet; public ushort Buttons; public byte LT; public byte RT; public short LX; public short LY; public short RX; public short RY; }
  [StructLayout(LayoutKind.Sequential)]
  public struct Vibration { public ushort Left; public ushort Right; }
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out State s);
  [DllImport("xinput1_4.dll")] public static extern int XInputSetState(int i, ref Vibration v);
}
"@
if ($Action -eq 'rumble') {
  foreach ($step in $args) {
    $left, $right, $ms = $step -split ':'
    $v = New-Object XI+Vibration; $v.Left = [int]$left; $v.Right = [int]$right
    [XI]::XInputSetState(0, [ref]$v) | Out-Null
    Start-Sleep -Milliseconds ([int]$ms)
  }
  exit
}
foreach ($i in 0..3) {
  $s = New-Object XI+State
  $r = [XI]::XInputGetState($i, [ref]$s)
  if ($r -eq 0) { "controller $($i + 1): buttons=0x{0:X4} LT={1} RT={2} LX={3} LY={4}" -f $s.Buttons, $s.LT, $s.RT, $s.LX, $s.LY }
  else { "controller $($i + 1): not connected" }
}
