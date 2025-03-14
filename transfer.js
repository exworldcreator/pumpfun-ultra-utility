const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transferSOL() {
  try {
    // Initialize connection with multiple fallback RPCs
    const rpcUrls = [
      'https://api.mainnet-beta.solana.com',
      'https://solana-api.projectserum.com',
      'https://rpc.ankr.com/solana'
    ];
    let connection = new Connection(rpcUrls[0]);
    
    // Load wallet sets
    const walletSets = JSON.parse(fs.readFileSync('./db/wallet-sets.json', 'utf-8'));
    const set14q = walletSets['14q'];
    
    if (!set14q) {
      throw new Error('Wallet set 14q not found');
    }
    
    // Get wallet #24 from set 14q
    const sourceWallet = set14q.wallets.find(w => w.NUMBER === "24");
    if (!sourceWallet) {
      throw new Error('Source wallet #24 not found in set 14q');
    }
    
    // Create source keypair
    const sourceKeypair = Keypair.fromSecretKey(
      Buffer.from(sourceWallet.PRIVATE_KEY, 'base64')
    );
    
    // Destination address
    const destinationPubkey = new PublicKey('AXBUf3jHwhC8GPKvG5aSiHR3C1NzbFmuwSYkuhbU9mef');
    
    // Check source balance
    const balance = await connection.getBalance(sourceKeypair.publicKey);
    console.log(`Source wallet balance: ${balance / LAMPORTS_PER_SOL} SOL`);
    
    // Minimum balance requirement reduced to 890,880 lamports (minimum rent exemption)
    const MIN_BALANCE = 890880;
    
    if (balance <= MIN_BALANCE) {
      throw new Error(`Insufficient balance in source wallet. Minimum required: ${MIN_BALANCE / LAMPORTS_PER_SOL} SOL`);
    }
    
    // Create transfer transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sourceKeypair.publicKey,
        toPubkey: destinationPubkey,
        lamports: balance - MIN_BALANCE // Leave minimum rent exemption
      })
    );
    
    // Get latest blockhash with retry logic
    async function getBlockhashWithRetry() {
      for (let i = 0; i < rpcUrls.length; i++) {
        try {
          connection = new Connection(rpcUrls[i]);
          await sleep(2000); // Add delay before RPC request
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
          console.log(`Successfully got blockhash from RPC ${i}`);
          return { blockhash, lastValidBlockHeight };
        } catch (error) {
          console.log(`Failed to get blockhash from RPC ${i}, trying next...`);
          if (i === rpcUrls.length - 1) throw error;
          await sleep(2000); // Add delay before trying next RPC
        }
      }
    }
    
    const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    
    // Send and confirm transaction with retry logic
    let signature;
    for (let i = 0; i < rpcUrls.length; i++) {
      try {
        connection = new Connection(rpcUrls[i]);
        await sleep(2000); // Add delay before transaction
        signature = await sendAndConfirmTransaction(
          connection,
          transaction,
          [sourceKeypair],
          {
            commitment: 'confirmed',
            preflightCommitment: 'confirmed',
          }
        );
        console.log(`Successfully sent transaction through RPC ${i}`);
        break;
      } catch (error) {
        console.log(`Failed to send transaction through RPC ${i}, trying next...`);
        console.error('Error details:', error.message);
        if (i === rpcUrls.length - 1) throw error;
        await sleep(2000); // Add delay before trying next RPC
      }
    }
    
    console.log('Transaction signature:', signature);
    
    // Check new balances
    const newSourceBalance = await connection.getBalance(sourceKeypair.publicKey);
    const newDestBalance = await connection.getBalance(destinationPubkey);
    
    console.log(`New source wallet balance: ${newSourceBalance / LAMPORTS_PER_SOL} SOL`);
    console.log(`New destination wallet balance: ${newDestBalance / LAMPORTS_PER_SOL} SOL`);
    
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}

transferSOL().catch(console.error); 