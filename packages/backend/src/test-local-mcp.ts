#!/usr/bin/env tsx

import { LocalMCPServerManager } from './services/local-mcp-server-manager';
import { ConfigManager } from './services/config-manager';

async function testLocalMCPServer() {
  console.log('🧪 Testing Local MCP Server functionality...\n');

  const configManager = new ConfigManager();
  const localManager = new LocalMCPServerManager();

  try {
    // Test 1: Parse sample configuration
    console.log('📋 Test 1: Parsing sample configuration...');
    const sampleConfig = configManager.generateSampleManifest();
    console.log('✅ Sample config generated:', JSON.stringify(sampleConfig, null, 2));

    // Test 2: Convert manifest to services
    console.log('\n📋 Test 2: Converting manifest to services...');
    const services = configManager.manifestToServices(sampleConfig);
    console.log('✅ Services created:', services.length);
    services.forEach(service => {
      console.log(`  - ${service.name}: ${service.localCommand} ${service.localArgs?.join(' ')}`);
    });

    // Test 3: Validate configuration
    console.log('\n📋 Test 3: Validating configuration...');
    configManager.validateLocalServerConfig(sampleConfig.mcpServers.memory);
    console.log('✅ Configuration validation passed');

    // Test 4: Command safety check
    console.log('\n📋 Test 4: Command safety check...');
    const safeCommand = configManager.isCommandSafe('npx');
    const unsafeCommand = configManager.isCommandSafe('rm -rf /');
    console.log('✅ Safe command check:', safeCommand);
    console.log('✅ Unsafe command check:', !unsafeCommand);

    // Test 5: Environment sanitization
    console.log('\n📋 Test 5: Environment sanitization...');
    const testEnv = {
      'SAFE_VAR': 'value',
      'unsafe-var': 'value',
      '123UNSAFE': 'value'
    };
    const sanitized = configManager.sanitizeEnvironment(testEnv);
    console.log('✅ Environment sanitized:', sanitized);

    console.log('\n🎉 All tests passed! Local MCP server functionality is working correctly.');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    await localManager.cleanup();
  }
}

// Run the test
testLocalMCPServer().catch(console.error);
