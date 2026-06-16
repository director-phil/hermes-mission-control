// Simple debug version of system health check to isolate the problem

export const dynamic = "force-dynamic";

export async function GET() {
  console.log("Starting system health check");
  
  // Test just one simple check to see if it works
  try {
    console.log("Testing simple CPU load check...");
    const cpuLoad = await readCpuLoad();
    console.log("CPU load result:", cpuLoad);
    
    console.log("Testing memory info...");
    const memInfo = await readMemoryInfo(); 
    console.log("Memory info result:", memInfo);
    
    console.log("Testing disk info...");
    const diskInfo = await readDiskInfo("/");
    console.log("Disk info result:", diskInfo);
    
    console.log("All checks passed");
    return Response.json({
      timestamp: new Date().toISOString(),
      systems: [
        {
          name: "GB10 #1",
          status: "healthy",
          metric: `${cpuLoad.load}% CPU · ${memInfo.percent}% RAM · ${diskInfo.percent}% disk`,
          last_checked: new Date().toISOString(),
          evidence: "local test"
        }
      ],
      total: 1,
      healthy: 1,
      warning: 0,
      critical: 0,
      unreachable: 0
    });
    
  } catch (error) {
    console.error("Error in system health check:", error);
    return Response.json({
      timestamp: new Date().toISOString(),
      error: "System health check failed",
      details: (error as Error).message || String(error)
    }, { status: 500 });
  }
}

async function readCpuLoad(): Promise<{ load: number }> {
  console.log("Reading CPU load...");
  try {
    const result = await runCommand("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", 3000);
    console.log("CPU command result:", result);
    if (result.success) {
      const load = parseFloat(result.output);
      return { load: isNaN(load) ? 0 : load };
    }
  } catch (err) {
    console.error("Error reading CPU load:", err);
  }
  return { load: 0 };
}

async function readMemoryInfo(): Promise<{ used: number; total: number; percent: number }> {
  console.log("Reading memory info...");
  try {
    const result = await runCommand("free -m | awk '/^Mem:/{print $2, $3}'", 3000);
    console.log("Memory command result:", result);
    if (result.success) {
      const parts = result.output.trim().split(/\s+/);
      const total = parseFloat(parts[0]) || 1;
      const used = parseFloat(parts[1]) || 0;
      return {
        used: Math.round(used / 1024 * 100) / 100,
        total: Math.round(total / 1024 * 100) / 100,
        percent: Math.round((used / total) * 100),
      };
    }
  } catch (err) {
    console.error("Error reading memory info:", err);
  }
  return { used: 0, total: 0, percent: 0 };
}

async function readDiskInfo(mount: string): Promise<{ used: number; total: number; percent: number }> {
  console.log("Reading disk info...");
  try {
    const result = await runCommand(`df -m ${mount} | awk 'NR==2{print $2, $3}'`, 3000);
    console.log("Disk command result:", result);
    if (result.success) {
      const parts = result.output.trim().split(/\s+/);
      const total = parseFloat(parts[0]) || 1;
      const used = parseFloat(parts[1]) || 0;
      return {
        used: Math.round(used / 1024 * 100) / 100,
        total: Math.round(total / 1024 * 100) / 100,
        percent: Math.round((used / total) * 100),
      };
    }
  } catch (err) {
    console.error("Error reading disk info:", err);
  }
  return { used: 0, total: 0, percent: 0 };
}

interface CmdResult {
  success: boolean;
  output: string;
  error?: string;
}

async function runCommand(cmd: string, timeout: number): Promise<CmdResult> {
  console.log("Running command with timeout:", cmd);
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const proc = spawn(cmd, { shell: true });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    
    // Set a timeout to kill the process if it takes too long
    const timer = setTimeout(() => {
      console.log(`Timeout reached after ${timeout}ms`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
        resolve({ success: false, output: "", error: `Timeout after ${timeout}ms` });
      }, 100);
    }, timeout);
    
    proc.on("close", (code: number) => {
      // Clear the timeout timer when process completes
      clearTimeout(timer);
      console.log(`Process completed with code: ${code}`);
      
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
      }
    });
    
    proc.on("error", (err: Error) => {
      // Clear the timeout timer when process errors
      clearTimeout(timer);
      console.log("Process error:", err.message);
      resolve({ success: false, output: "", error: err.message });
    });
  });
}