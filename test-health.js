// Simple test to isolate the problem
const { spawn } = require('child_process');

async function runTest() {
  console.log("Testing system health endpoint directly...");
  
  // Test a simple command that should work
  const commands = [
    'top -bn1 | grep "Cpu(s)" | awk "{print $2}"',
    'free -m | awk "/^Mem:/{print $2, $3}"',
    'df -m / | awk "NR==2{print $2, $3}"'
  ];
  
  for (const cmd of commands) {
    console.log(`\nTesting command: ${cmd}`);
    
    const result = await new Promise((resolve) => {
      const proc = spawn(cmd, { shell: true });
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      
      const timer = setTimeout(() => {
        console.log("Timeout reached for command");
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
          resolve({ success: false, output: '', error: `Timeout after 3000ms` });
        }, 100);
      }, 3000);
      
      proc.on('close', (code) => {
        clearTimeout(timer);
        console.log(`Process completed with code: ${code}`);
        if (code === 0) {
          resolve({ success: true, output: stdout });
        } else {
          resolve({ success: false, output: stdout, error: stderr.trim() || `Exit code ${code}` });
        }
      });
      
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, output: '', error: err.message });
      });
    });
    
    console.log(`Result:`, result);
  }
}

runTest().catch(console.error);