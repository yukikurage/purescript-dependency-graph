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

const splitWithLine = (source: string) => {
	return source.split(/\r\n|\n\r|\n|\r/);
};

const deleteUnnecessary = (source: string) => {
	//コメント，ダブルクオーテーション，括弧とその中身を削除
	return source.replace(/\".*?\"/gs, '').replace(/\{-.*?-\}/gs, '').replace(/--.*?($|(?=(\n|\r|\r\n)))/g, '').replace(/\(.*?\)/gs, '');
};

const splitWithAnySpace = (source: string) => {
	return source.split(/\s+/);
};

// deleteUnnecessaryとsplitWithLineを行ってから投入
const getModuleName = (splitedSource: string[]) => {
	const definedLine = splitedSource.find(line => line.match(/^module .*?/g));
	if (definedLine === undefined) {
		return undefined;
	}
	return splitWithAnySpace(definedLine)[1];
};

const getDependencies = (splitedSource: string[]) => {
	const definedLines = splitedSource.filter(line => line.match(/^import .*?/g));
	return definedLines.map(line => splitWithAnySpace(line)[1]);
};


const getSourceFileUri = async (currentUri: vscode.Uri, extension: string) => {
	const ls = await vscode.workspace.fs.readDirectory(currentUri);
	const purFiles = ls.filter(module => module[0].match(new RegExp('\\.' + extension + '$')) && module[1] === 1);
	const folders = ls.filter(module => module[1] === 2);

	let result: vscode.Uri[] = [];
	for (let module of purFiles) {
		result.push(vscode.Uri.joinPath(currentUri, module[0]));
	}
	for (let folder of folders) {
		result = result.concat(await getSourceFileUri(vscode.Uri.joinPath(currentUri, folder[0]), extension));
	}
	return result;
};

const getSelectedModules = async (sourceFileUri: vscode.Uri[], selectingRegExp: RegExp) => {
	let result: {uri: vscode.Uri, moduleName: string}[] = [];

	for (let uri of sourceFileUri) {
		const sourceUInt = await vscode.workspace.fs.readFile(uri);

		const splitedSource = splitWithLine(deleteUnnecessary(new TextDecoder().decode(sourceUInt)));

		const moduleName = getModuleName(splitedSource);

		if (moduleName === undefined) {
			vscode.window.showInformationMessage(`Can not parse a module name. At line: ${uri.toString(true)}`);
			continue;
		}

		if (!moduleName?.match(selectingRegExp)) { continue; }
		result.push({uri: uri, moduleName: moduleName});
	}
	return result;
};

const makeModuleTree = async (currentUri: vscode.Uri, extension: string, selectingRegExp: RegExp) => {
	const sourceFileUri = await getSourceFileUri(currentUri, extension);
	const selectedModules = await getSelectedModules(sourceFileUri, selectingRegExp);

	const moduleTree = new ModuleTree('Root');

	for (let selectedModule of selectedModules) {
		const sourceUInt = await vscode.workspace.fs.readFile(selectedModule.uri);
		const splitedSource = splitWithLine(deleteUnnecessary(new TextDecoder().decode(sourceUInt)));

		moduleTree.addModule(selectedModule.moduleName.split('.'));

		const dependencies = getDependencies(splitedSource);

		for (let depending of dependencies) {
			if (selectedModules.map (x => x.moduleName).includes(depending)) {
				moduleTree.addDependencies(selectedModule.moduleName.split('.'), depending);
			}
		}
	}
	return moduleTree;
};

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

export function activate(context: vscode.ExtensionContext) {
	console.log('"purescript-dependency-graph" is now active');

	const drawGraph = vscode.commands.registerCommand('purescript-dependency-graph.drawGraph', async () => {
		const config = vscode.workspace.getConfiguration('purescript-dependency-graph');

		const workspaceFolders = vscode.workspace.workspaceFolders;
		let rootUri: vscode.Uri;
		if (workspaceFolders === undefined) {
			rootUri = vscode.Uri.parse("");
			vscode.window.showInformationMessage('No Opened Workspace here...');
			return;
		} else {
			rootUri = workspaceFolders[0].uri;
		}

		const sourcesDirectory = vscode.Uri.joinPath(rootUri, config.get('sourcesDirectory', ''));
		try {
			await vscode.workspace.fs.stat(sourcesDirectory);
		} catch {
			vscode.window.showInformationMessage(`${sourcesDirectory.toString(true)} file does not exist`);
			return;
		}

		const selectingRegExp: RegExp = config.get('selectedModules', /.*/);
		const outputFile: vscode.Uri = vscode.Uri.joinPath(rootUri, config.get('outputFile', 'purescript-dependency-graph/output.md'));
		const extension: string = config.get('extension', 'purs');

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
		}, async (progress) => {
			progress.report({
				message: `Drawing Graph ...`,
			});

			const moduleTree = await makeModuleTree(sourcesDirectory, extension, selectingRegExp);
			vscode.workspace.fs.writeFile(outputFile, new TextEncoder().encode(makeGraph(moduleTree)));
		});
	});
	context.subscriptions.push(drawGraph);
}

export function deactivate() { }
