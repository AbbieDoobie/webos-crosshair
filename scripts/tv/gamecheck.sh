#!/bin/sh
# Run on the TV: prints game mode, ALLM, VRR, HDR, and resolution with the crosshair off,
# on, and off again, to show the crosshair does not change them. Leaves the crosshair off.

snap() {
  luna-send -n 1 luna://com.webos.service.videooutput/getStatus '{}' | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const v=JSON.parse(s).video.find(x=>x.sink==="MAIN"); const i=v.videoInfo||{};
      console.log(JSON.stringify({app:v.appId, res:v.width+"x"+v.height+"@"+v.frameRate, game:i.isGameMode,
        allm:i.allmEnabled, vrr:(i.hdmiVrrInfo||{}).vrrEnabled, hdr:i.hdrType, hfr:i.hfrEnabled}));});'
  luna-send -n 1 luna://com.webos.settingsservice/getSystemSettings '{"category":"picture","keys":["pictureMode"]}' | grep -oE '"(pictureMode|dynamicRange)": *"[^"]*"' | tr '\n' ' '; echo
}
echo "before:"; snap
luna-send -n 1 luna://org.abbie.crosshair.service/show '{}' >/dev/null; sleep 3
echo "with crosshair:"; snap
luna-send -n 1 luna://com.webos.surfacemanager/getFocusedWindowInfo '{}' | grep -o '"appId": "[^"]*"' | head -1
luna-send -n 1 luna://org.abbie.crosshair.service/hide '{}' >/dev/null; sleep 2
echo "after:"; snap
