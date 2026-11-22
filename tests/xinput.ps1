# Prints the four XInput controllers the way games read them, one line each.
Add-Type @"
using System.Runtime.InteropServices;
public static class XI {
  [StructLayout(LayoutKind.Sequential)]
  public struct State { public uint Packet; public ushort Buttons; public byte LT; public byte RT; public short LX; public short LY; public short RX; public short RY; }
  [DllImport("xinput1_4.dll")] public static extern int XInputGetState(int i, out State s);
}
"@
foreach ($i in 0..3) {
  $s = New-Object XI+State
  $r = [XI]::XInputGetState($i, [ref]$s)
  if ($r -eq 0) { "controller $($i + 1): buttons=0x{0:X4} LT={1} RT={2} LX={3} LY={4}" -f $s.Buttons, $s.LT, $s.RT, $s.LX, $s.LY }
  else { "controller $($i + 1): not connected" }
}
