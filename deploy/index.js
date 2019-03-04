'use strict';

const path = require('path');
const fs = require('fs');
const program = require('commander');
const { gray, green, yellow, red } = require('chalk');
const { table } = require('table');
const Web3 = require('web3');

require('dotenv').config();

const { findSolFiles, flatten, compile } = require('./solidity');
const { deploy } = require('./deployment');

const COMPILED_FOLDER = 'compiled';
const FLATTENED_FOLDER = 'flattened';

program
	.command('build')
	.description('Build (flatten and compile) solidity files')
	.option(
		'-b, --build-path [value]',
		'Build path for built files',
		path.join(__dirname, '..', 'build')
	)
	.action(async ({ buildPath }) => {
		console.log(gray('Starting build...'));

		// Flatten all the contracts.
		// Start with the libraries, then copy our own contracts on top to ensure
		// if there's a naming clash our code wins.
		console.log(gray('Finding .sol files...'));
		const libraries = findSolFiles('node_modules');
		const contracts = findSolFiles('contracts');
		const allSolFiles = { ...libraries, ...contracts };

		console.log(gray('Flattening contracts...'));
		const sources = await flatten({ files: allSolFiles, contracts });

		const flattenedPath = path.join(buildPath, FLATTENED_FOLDER);
		Object.entries(sources).forEach(([key, { content }]) => {
			const toWrite = path.join(flattenedPath, key);
			try {
				// try make path for sub-folders (note: recursive flag only from nodejs 10.12.0)
				fs.mkdirSync(path.dirname(toWrite), { recursive: true });
			} catch (e) {}
			fs.writeFileSync(toWrite, content);
		});

		// Ok, now we need to compile all the files.
		console.log(gray('Compiling contracts...'));
		const { artifacts, errors, warnings } = compile({ sources });
		const compiledPath = path.join(buildPath, COMPILED_FOLDER);
		Object.entries(artifacts).forEach(([key, value]) => {
			const toWrite = path.join(compiledPath, key);
			try {
				// try make path for sub-folders (note: recursive flag only from nodejs 10.12.0)
				fs.mkdirSync(path.dirname(toWrite), { recursive: true });
			} catch (e) {}
			fs.writeFileSync(`${toWrite}.json`, JSON.stringify(value));
		});

		console.log(yellow(`Compiled with ${warnings.length} warnings and ${errors.length} errors`));
		if (errors.length > 0) {
			console.error(red(errors));
			console.error();
			console.error(gray('Exiting because of compile errors.'));
			process.exit(1);
		}

		// We're built!
		console.log(green('Build succeeded'));
	});

program
	.command('deploy')
	.description('Deploy compiled solidity files')
	.option('-n, --network <value>', 'The network to run off.', 'kovan')
	.option(
		'-c, --contract-deployment-gas-limit <value>',
		'Contract deployment gas limit',
		parseInt,
		65e5
	)
	.option('-m, --method-call-gas-limit <value>', 'Method call gas limit', parseInt, 15e4)
	.option('-g, --gas-price <value>', 'Gas price', parseInt, 1)
	.option('-s, --synth-list <value>', 'Path to a list of synths', './synths.json')
	.option(
		'-f, --contract-flags <value>',
		'Path to a list of contract flags',
		path.join(__dirname, 'contract-flags.json')
	)
	.option(
		'-o, --output-path <value>',
		'Path to a list of deployed contract addresses',
		path.join(__dirname, 'out')
	)
	.option(
		'-b, --build-path [value]',
		'Build path for built files',
		path.join(__dirname, '..', 'build')
	)
	.action(
		async ({
			contractFlags,
			gasPrice,
			methodCallGasLimit,
			contractDeploymentGasLimit,
			network,
			buildPath,
			outputPath,
		}) => {
			console.log(gray(`Starting deployment to ${network.toUpperCase()} via Infura...`));

			const contracts = JSON.parse(fs.readFileSync(contractFlags));

			console.log(
				gray('Checking all contracts not flagged for deployment have addresses in this network...')
			);
			const deployedContractAddressFile = path.join(outputPath, network, 'contracts.json');
			const deployedContractAddresses = JSON.parse(fs.readFileSync(deployedContractAddressFile));

			const missingDeployments = Object.keys(contracts).filter(contractName => {
				return !contracts[contractName].deploy && !deployedContractAddresses[contractName];
			});

			if (missingDeployments.length) {
				console.error(
					red(
						`Cannot use existing contracts for deployment as addresses not found for the following contracts on ${network}:`
					)
				);
				console.error(missingDeployments.join('\n'));
				console.error(gray(`Used: ${deployedContractAddressFile} as source`));
				process.exit(1);
			}

			console.log(gray('Loading the compiled contracts locally...'));
			const compiledSourcePath = path.join(buildPath, COMPILED_FOLDER);

			const compiled = Object.entries(contracts).reduce(
				(memo, [contractName, { deploy, contract }]) => {
					const sourceFile = path.join(compiledSourcePath, `${contract}.json`);
					if (!fs.existsSync(sourceFile)) {
						console.error(red(`Cannot find compiled contract code for: ${contract}`));
						process.exit(1);
					}
					memo[contractName] = JSON.parse(fs.readFileSync(sourceFile));
					return memo;
				},
				{}
			);

			// Configure Web3 so we can sign transactions and connect to the network.
			const web3 = new Web3(
				new Web3.providers.HttpProvider(`https://${network}.infura.io/${process.env.INFURA_KEY}`)
			);

			web3.eth.accounts.wallet.add(process.env.DEPLOY_PRIVATE_KEY);
			web3.eth.defaultAccount = web3.eth.accounts.wallet[0].address;
			console.log(gray(`Using account with public key ${web3.eth.defaultAccount}`));

			const account = web3.eth.defaultAccount;
			const sendParameters = (type = 'method-call') => ({
				from: web3.eth.defaultAccount, // Ugh, what's the point of a defaultAccount if we have to set it anyway?
				gas: type === 'method-call' ? methodCallGasLimit : contractDeploymentGasLimit,
				gasPrice: web3.utils.toWei(gasPrice, 'gwei'),
			});

			// Now begin deployment
			const deployedContracts = {};
			const deployContract = async ({ name, args }) => {
				const { deploy } = contracts[name];
				if (deploy) console.log(gray(` - Attempting to deploy ${name}`));
				else console.log(gray(` - Reusing instance of ${name}`));

				const deployed = await deploy({
					name,
					contractName: contracts[name].contract,
					deploy,
					existingAddress: deployedContractAddresses[name],
					compiled: compiled[name],
					deployedContracts,
					args,
				});
				console.log(`Deployed ${name} to ${deployed.options.address}`);
				deployedContracts[name] = deployed;
				return deployed;
			};

			await deployContract({
				name: 'SafeDecimalMath',
			});

			const exchangeRates = await deployContract({
				name: 'ExchangeRates',
				args: [
					account,
					account,
					[web3.utils.asciiToHex('SNX')],
					[web3.utils.toWei('0.2', 'ether')],
				],
			});

			const feePoolProxy = await deployContract({
				name: 'ProxyFeePool',
				args: [account],
			});

			// const feePool = await deploy('FeePool', [
			// 	feePoolProxy.options.address,
			// 	account,
			// 	account,
			// 	account,
			// 	web3.utils.toWei('0.0015', 'ether'),
			// 	web3.utils.toWei('0.0015', 'ether'),
			// ]);

			// if (
			// 	settings.contracts.Proxy.FeePool.action === 'deploy' ||
			// 	settings.contracts.FeePool.action === 'deploy'
			// ) {
			// 	await feePoolProxy.methods.setTarget(feePool.options.address).send(sendParameters());
			// }

			// const synthetixState = await deployContract('SynthetixState', [account, account]);
			// const synthetixProxy = await deployContract('Proxy.Synthetix', [account]);
			// const synthetixTokenState = await deployContract('TokenState.Synthetix', [account, account]);
			// const synthetix = await deployContract('Synthetix', [
			// 	synthetixProxy.options.address,
			// 	synthetixTokenState.options.address,
			// 	synthetixState.options.address,
			// 	account,
			// 	exchangeRates.options.address,
			// 	feePool.options.address,
			// ]);

			// if (
			// 	settings.contracts.Proxy.Synthetix.action === 'deploy' ||
			// 	settings.contracts.Synthetix.action === 'deploy'
			// ) {
			// 	console.log('Setting target on Synthetix Proxy...');
			// 	await synthetixProxy.methods.setTarget(synthetix.options.address).send(sendParameters());
			// }

			// if (settings.contracts.TokenState.Synthetix.action === 'deploy') {
			// 	console.log('Setting balance on Synthetix Token State...');
			// 	await synthetixTokenState.methods
			// 		.setBalanceOf(account, web3.utils.toWei('100000000'))
			// 		.send(sendParameters());
			// }

			// if (
			// 	settings.contracts.TokenState.Synthetix.action === 'deploy' ||
			// 	settings.contracts.Synthetix.action === 'deploy'
			// ) {
			// 	console.log('Setting associated contract on Synthetix Token State...');
			// 	await synthetixTokenState.methods
			// 		.setAssociatedContract(synthetix.options.address)
			// 		.send(sendParameters());
			// 	console.log('Setting associated contract on Synthetix State...');
			// 	await synthetixState.methods
			// 		.setAssociatedContract(synthetix.options.address)
			// 		.send(sendParameters());
			// }

			// const synthetixEscrow = await deployContract('SynthetixEscrow', [
			// 	account,
			// 	synthetix.options.address,
			// ]);

			// if (
			// 	settings.contracts.Synthetix.action === 'deploy' ||
			// 	settings.contracts.SynthetixEscrow.action === 'deploy'
			// ) {
			// 	console.log('Setting escrow on Synthetix...');
			// 	await synthetix.methods.setEscrow(synthetixEscrow.options.address).send(sendParameters());

			// 	// Comment out if deploying on mainnet - Needs to be owner of synthetixEscrow contract
			// 	if (settings.contracts.SynthetixEscrow.action !== 'deploy') {
			// 		console.log('Setting deployed Synthetix on escrow...');
			// 		await synthetixEscrow.methods
			// 			.setSynthetix(synthetix.options.address)
			// 			.send(sendParameters());
			// 	}
			// }

			// // Comment out if deploying on mainnet - Needs to be owner of feePool contract
			// if (
			// 	settings.contracts.FeePool.action === 'deploy' ||
			// 	settings.contracts.Synthetix.action === 'deploy'
			// ) {
			// 	console.log('Setting Synthetix on Fee Pool...');
			// 	await feePool.methods.setSynthetix(synthetix.options.address).send(sendParameters());
			// }

			// // ----------------
			// // Synths
			// // ----------------
			// for (const currencyKey of settings.synths) {
			// 	const tokenState = await deployContract(`TokenState.${currencyKey}`, [
			// 		account,
			// 		ZERO_ADDRESS,
			// 	]);
			// 	const tokenProxy = await deployContract(`Proxy.${currencyKey}`, [account]);
			// 	const synth = await deployContract(`Synth.${currencyKey}`, [
			// 		tokenProxy.options.address,
			// 		tokenState.options.address,
			// 		synthetix.options.address,
			// 		feePool.options.address,
			// 		`Synth ${currencyKey}`,
			// 		currencyKey,
			// 		account,
			// 		web3.utils.asciiToHex(currencyKey),
			// 	]);

			// 	if (
			// 		settings.contracts.Synth[currencyKey].action === 'deploy' ||
			// 		settings.contracts.TokenState[currencyKey].action === 'deploy'
			// 	) {
			// 		console.log(`Setting associated contract for ${currencyKey} TokenState...`);

			// 		await tokenState.methods
			// 			.setAssociatedContract(synth.options.address)
			// 			.send(sendParameters());
			// 	}
			// 	if (
			// 		settings.contracts.Proxy[currencyKey].action === 'deploy' ||
			// 		settings.contracts.Synth[currencyKey].action === 'deploy'
			// 	) {
			// 		console.log(`Setting proxy target for ${currencyKey} Proxy...`);

			// 		await tokenProxy.methods.setTarget(synth.options.address).send(sendParameters());
			// 	}

			// 	// Comment out if deploying on mainnet - Needs to be owner of Synthetix contract
			// 	if (
			// 		settings.contracts.Synth[currencyKey].action === 'deploy' ||
			// 		settings.contracts.Synthetix.action === 'deploy'
			// 	) {
			// 		console.log(`Adding ${currencyKey} to Synthetix contract...`);

			// 		await synthetix.methods.addSynth(synth.options.address).send(sendParameters());
			// 	}

			// 	// Comment out if deploying on mainnet - Needs to be owner of existing Synths contract
			// 	if (
			// 		settings.contracts.Synth[currencyKey].action === 'use-existing' &&
			// 		settings.contracts.Synthetix.action === 'deploy'
			// 	) {
			// 		console.log(`Adding Synthetix contract on ${currencyKey} contract...`);

			// 		await synth.methods.setSynthetix(synthetix.options.address).send(sendParameters());
			// 	}
			// }

			// const depot = await deployContract('Depot', [
			// 	account,
			// 	account,
			// 	synthetix.options.address,
			// 	deployedContracts['Synth.sUSD'].options.address,
			// 	feePool.options.address,
			// 	account,
			// 	web3.utils.toWei('500'),
			// 	web3.utils.toWei('.10'),
			// ]);

			// // Comment out if deploying on mainnet - Needs to be owner of Depot contract
			// if (
			// 	settings.contracts.Synthetix.action === 'deploy' &&
			// 	settings.contracts.Depot.action !== 'deploy'
			// ) {
			// 	console.log(`setting synthetix on depot contract...`);

			// 	await depot.methods.setSynthetix(synthetix.options.address).send(sendParameters());
			// }

			// console.log();
			// console.log();
			// console.log(' Successfully deployed all contracts:');
			// console.log();

			// const tableData = Object.keys(deployedContracts).map(key => [
			// 	key,
			// 	deployedContracts[key].options.address,
			// ]);

			// await deployedContractsToJSON();

			// console.log(table(tableData));
		}
	);

program.parse(process.argv);
