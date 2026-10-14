// JXA diagnostic invoked by osascript on the native macOS CI runner.
// Core Graphics and AppKit expose geometry without UI automation permission.
function run(inputArguments) {
  ObjC.import("AppKit");
  ObjC.import("CoreGraphics");
  const ownerPid = Number(inputArguments[0]);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) throw new Error("Expected the owned application PID.");
  const nativeScreens = $.NSScreen.screens;
  const screenCount = Number(nativeScreens.count);
  if (!screenCount) throw new Error("No native displays are available.");
  const primary = nativeScreens.objectAtIndex(0).frame;
  const desktopTop = primary.origin.y + primary.size.height;
  const screens = [];
  function topLeft(rectangle) {
    // Cocoa uses a bottom-left global origin; CGWindowBounds uses top-left.
    // Both APIs use logical points, including on Retina/scaled displays.
    return { x: rectangle.origin.x, y: desktopTop - rectangle.origin.y - rectangle.size.height, width: rectangle.size.width, height: rectangle.size.height };
  }
  for (let index = 0; index < screenCount; index += 1) {
    const screen = nativeScreens.objectAtIndex(index);
    screens.push({ index, scaleFactor: Number(screen.backingScaleFactor), frame: topLeft(screen.frame), workArea: topLeft(screen.visibleFrame) });
  }
  // 1 = kCGWindowListOptionOnScreenOnly; 0 = kCGNullWindowID.
  const nativeWindows = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(1, 0));
  const windows = nativeWindows.filter(info => Number(info.kCGWindowOwnerPID) === ownerPid && Number(info.kCGWindowLayer) === 0)
    .map(info => ({ id: info.kCGWindowNumber, bounds: { x: info.kCGWindowBounds.X, y: info.kCGWindowBounds.Y, width: info.kCGWindowBounds.Width, height: info.kCGWindowBounds.Height } }))
    .filter(window => window.bounds.width >= 500 && window.bounds.height >= 300);
  return JSON.stringify({ ownerPid, units: "logical-points", origin: "global-top-left", screens, windows });
}
