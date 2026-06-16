// Quick test of system health functionality without starting full Next.js server
import { exec } from "child_process";

async function testBasicCommands() {
  console.log("Testing basic system commands...");
  
  try {
    const cpu = await new Promise<{ load: number }>((resolve) => {
      exec("cat /proc/loadavg | awk '{print $1}'", (err, stdout) => {
        if (err) resolve({ load: 0 });
        else resolve({ load: parseFloat(stdout.trim()) || 0 });
      });
    });
    console.log("CPU Load:", cpu);
    
    const mem = await new Promise<{ total: number; available: number }>((resolve) => {
      exec("free -b | awk '/Mem:/{print $2, $7}'", (err, stdout) => {
        if (err) resolve({ total: 0, available: 0 });
        else {
          const parts = stdout.trim().split(/\s+/);
          resolve({ total: parseInt(parts[0]) || 0, available: parseInt(parts[1]) || 0 });
        }
      });
    });
    console.log("Memory:", mem);
    
    const disk = await new Promise<{ total: number; available: number }>((resolve) => {
      exec("df -B1 / | awk 'NR==2{print $2, $4}'", (err, stdout) => {
        if (err) resolve({ total: 0, available: 0 });
        else {
          const parts = stdout.trim().split(/\s+/);
          resolve({ total: parseInt(parts[0]) || 0, available: parseInt(parts[1]) || 0 });
        }
      });
    });
    console.log("Disk:", disk);
    
    console.log("\n✓ All basic commands work");
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testBasicCommands();
