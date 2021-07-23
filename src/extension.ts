import { TextDecoder, TextEncoder } from 'util';
import * as vscode from 'vscode';

class ModuleTree {
	label: string;
	dependencies: string[] = [];
	children: ModuleTree[] = [];
	constructor(label: string) { this.label = label; }
	addDependencies(path: string[], dep: string) {
		if (path.length === 0) {
			this.dependencies.push(dep);
			console.log('added');
		} else {
			this.children.find(module => module.label === path[0])?.addDependencies(path.slice(1), dep);
		}
	}
	addModule(path: string[]) {
		if (path.length !== 0) {
			let newModule: ModuleTree;
			const found = this.children.find(module => module.label === path[0]);
			if (found === undefined) {
				newModule = new ModuleTree(path[0]);
				this.children.push(newModule);
			} else {
				newModule = found;
			}
			newModule.addModule(path.slice(1));
		}
	}
}

const makeGraph = (moduleTree: ModuleTree) => {
	let subgraphs = '';
	let dependencies = '';
	const loopFunc = (loopTree: ModuleTree, currentDir: string) => { //currentDir = 'Path.To.Module.' etc
		if (loopTree.children.length !== 0) {
			subgraphs += 'subgraph ' + currentDir + loopTree.label + '_subgraph [' + loopTree.label + ']\n';
			subgraphs += currentDir + loopTree.label + '[/' + loopTree.label + '/]\n';
			for (const mod of loopTree.children) {
				loopFunc(mod, currentDir + loopTree.label + '.');
			}
			subgraphs += 'end\n';
		} else {
			subgraphs += currentDir + loopTree.label + '[' + loopTree.label + ']\n';
		}
		for (const depending of loopTree.dependencies) {
			dependencies += currentDir + loopTree.label + ' --> ' + depending + '\n';
		}
	};
	for (const mod of moduleTree.children) {
		loopFunc(mod, '');
	}
	return '```mermaid\nflowchart LR\n' + subgraphs + dependencies + '```';
};

const inDirModules = async (currentUri: vscode.Uri) => {
	const ls = await vscode.workspace.fs.readDirectory(currentUri);
	const purFiles = ls.filter(module => module[0].match(/\.purs$/) && module[1] === 1);
	const folders = ls.filter(module => module[1] === 2);

	let result: string[] = [];

	for (let module of purFiles) {
		const sourceUInt = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(currentUri, module[0]));
		const source = new TextDecoder().decode(sourceUInt).replace(/{-.*?-}/g, '').replace(/--.*?($|(?=(\n|\r|\r\n)))/g, '');

		const moduleName = source.match(/module .*?($|(?=(\n|\r|\r\n)))/g)?.[0].split(/ /g)[1];
		if (moduleName === undefined) { continue; }
		result.push(moduleName);
	}

	for (let folder of folders) {
		result = result.concat(await inDirModules(vscode.Uri.joinPath(currentUri, folder[0])));
	}
	return result;
};

const makeModuleTree = async (currentUri: vscode.Uri, moduleTree: ModuleTree, selectingRegExp: RegExp, allModules: string[]) => {
	const ls = await vscode.workspace.fs.readDirectory(currentUri);
	const purFiles = ls.filter(module => module[0].match(/\.purs$/) && module[1] === 1);
	const folders = ls.filter(module => module[1] === 2);

	for (let module of purFiles) {
		const sourceUInt = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(currentUri, module[0]));
		const source = new TextDecoder().decode(sourceUInt).replace(/{-.*?-}/g, '').replace(/--.*?($|(?=(\n|\r|\r\n)))/g, '');

		const moduleName = source.match(/module .*?($|(?=(\n|\r|\r\n)))/g)?.[0].split(/[ |\(]/g)[1];

		if (moduleName === undefined || !moduleName?.match(selectingRegExp)) { continue; }

		moduleTree.addModule(moduleName.split('.'));

		const res = source.match(/import .*?($|(?=(\n|\r|\r\n)))/g)?.map(x => x.split(/[ |\(]/g)[1]);

		if (res !== null) {
			const nubRes = Array.from(new Set(res));
			for (let depending of nubRes) {
				if (depending.match(selectingRegExp) && allModules.includes(depending)) {
					moduleTree.addDependencies(moduleName.split('.'), depending);
				}
			}
		}
	}

	for (let folder of folders) {
		await makeModuleTree(vscode.Uri.joinPath(currentUri, folder[0]), moduleTree, selectingRegExp, allModules);
	}
};

export function activate(context: vscode.ExtensionContext) {
	console.log('"purescript-dependency-graph" is now active');

	const drawGraph = vscode.commands.registerCommand('purescript-dependency-graph.drawGraph', async () => {
		const config = vscode.workspace.getConfiguration('purescript-dependency-graph');

		const workspaceFolders = vscode.workspace.workspaceFolders;
		let rootUri: vscode.Uri;
		if (workspaceFolders === undefined) {
			rootUri = vscode.Uri.parse("");
			vscode.window.showInformationMessage('This project isn\'t valid');
			return;
		} else {
			rootUri = workspaceFolders[0].uri;
		}

		const sourcesDirectory = vscode.Uri.joinPath(rootUri, config.get('sourcesDirectory', ''));
		if (vscode.FileSystemError.FileNotADirectory(sourcesDirectory).code === 'FileNotADirectory'){
			vscode.window.showInformationMessage('This project isn\'t valid');
			return;
		}

		const selectingRegExp: RegExp = config.get('selectedModules', /.*/);
		const outputFile: vscode.Uri = vscode.Uri.joinPath(rootUri, config.get('outputFile', 'purescript-dependency-graph/output.md'));

		const moduleTree: ModuleTree = new ModuleTree("ModulesRoot");

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
		}, async (progress) => {
			progress.report({
				message: `Drawing Graph ...`,
			});

			const allModules = await inDirModules(sourcesDirectory);

			await makeModuleTree(sourcesDirectory, moduleTree, selectingRegExp, allModules);

			console.log(moduleTree);

			vscode.workspace.fs.writeFile(outputFile, new TextEncoder().encode(makeGraph(moduleTree)));
		})
	});
	context.subscriptions.push(drawGraph);
}

export function deactivate() { }
