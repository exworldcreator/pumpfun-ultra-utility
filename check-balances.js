const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

async function checkBalances() {
  try {
    const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=3a000b3a-3d3b-4e41-9b30-c75d439068f1', 'confirmed');
    const walletSets = JSON.parse(fs.readFileSync('./db/wallet-sets.json'));
    
    console.log('\nChecking payer wallet balances across all sets:');
    console.log('----------------------------------------');
    
    for (const setId in walletSets) {
      const wallets = walletSets[setId].wallets;
      const wallet24 = wallets.find(w => w.NUMBER === "24"); // Bundle payer
      const wallet25 = wallets.find(w => w.NUMBER === "25"); // Market making payer
      
      console.log(`\nSet ${setId}:`);
      
      if (wallet24) {
        try {
          const pubkey24 = new PublicKey(wallet24.PUBLIC_KEY);
          const balance24 = await connection.getBalance(pubkey24);
          const solBalance24 = balance24 / 1000000000;
          
          console.log(`Bundle Payer (#24):`);
          console.log(`Address: ${wallet24.PUBLIC_KEY}`);
          console.log(`Balance: ${solBalance24.toFixed(4)} SOL`);
          
          if (Math.abs(solBalance24 - 0.7) < 0.1) {
            console.log('!!! THIS MIGHT BE YOUR WALLET !!!');
            console.log('Private Key:', wallet24.PRIVATE_KEY);
          }
        } catch (e) {
          console.error(`Error checking wallet #24 in set ${setId}:`, e.message);
        }
      }
      
      if (wallet25) {
        try {
          const pubkey25 = new PublicKey(wallet25.PUBLIC_KEY);
          const balance25 = await connection.getBalance(pubkey25);
          const solBalance25 = balance25 / 1000000000;
          
          console.log(`Market Making Payer (#25):`);
          console.log(`Address: ${wallet25.PUBLIC_KEY}`);
          console.log(`Balance: ${solBalance25.toFixed(4)} SOL`);
        } catch (e) {
          console.error(`Error checking wallet #25 in set ${setId}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error('Error:', e);
  }
}

// Run the balance check
checkBalances(); 