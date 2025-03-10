import {
	disallowed_parapgraph_contents,
	interactive_elements,
	is_tag_valid_with_parent
} from '../../../constants.js';
import { error } from '../../errors.js';
import {
	extract_identifiers,
	get_parent,
	is_expression_attribute,
	is_text_attribute,
	object,
	unwrap_optional
} from '../../utils/ast.js';
import { warn } from '../../warnings.js';
import fuzzymatch from '../1-parse/utils/fuzzymatch.js';
import { binding_properties } from '../bindings.js';
import { ContentEditableBindings, EventModifiers, SVGElements } from '../constants.js';
import { is_custom_element_node } from '../nodes.js';
import {
	regex_illegal_attribute_character,
	regex_not_whitespace,
	regex_only_whitespaces
} from '../patterns.js';
import { Scope, get_rune } from '../scope.js';
import { merge } from '../visitors.js';
import { a11y_validators } from './a11y.js';

/**
 * @param {import('#compiler').Component | import('#compiler').SvelteComponent | import('#compiler').SvelteSelf} node
 * @param {import('zimmerframe').Context<import('#compiler').SvelteNode, import('./types.js').AnalysisState>} context
 */
function validate_component(node, context) {
	for (const attribute of node.attributes) {
		if (
			attribute.type !== 'Attribute' &&
			attribute.type !== 'SpreadAttribute' &&
			attribute.type !== 'LetDirective' &&
			attribute.type !== 'OnDirective' &&
			attribute.type !== 'BindDirective'
		) {
			error(attribute, 'invalid-component-directive');
		}

		if (
			attribute.type === 'OnDirective' &&
			(attribute.modifiers.length > 1 || attribute.modifiers.some((m) => m !== 'once'))
		) {
			error(attribute, 'invalid-event-modifier');
		}

		if (attribute.type === 'Attribute') {
			validate_attribute_name(attribute, context);

			if (attribute.name === 'slot') {
				validate_slot_attribute(context, attribute);
			}
		}
	}

	context.next({
		...context.state,
		parent_element: null,
		component_slots: new Set()
	});
}

const react_attributes = new Map([
	['className', 'class'],
	['htmlFor', 'for']
]);

/**
 * @param {import('#compiler').RegularElement | import('#compiler').SvelteElement} node
 * @param {import('zimmerframe').Context<import('#compiler').SvelteNode, import('./types.js').AnalysisState>} context
 */
function validate_element(node, context) {
	let has_animate_directive = false;
	let has_in_transition = false;
	let has_out_transition = false;

	for (const attribute of node.attributes) {
		if (attribute.type === 'Attribute') {
			if (regex_illegal_attribute_character.test(attribute.name)) {
				error(attribute, 'invalid-attribute-name', attribute.name);
			}

			if (attribute.name.startsWith('on') && attribute.name.length > 2) {
				if (!is_expression_attribute(attribute)) {
					error(attribute, 'invalid-event-attribute-value');
				}

				const value = attribute.value[0].expression;
				if (
					value.type === 'Identifier' &&
					value.name === attribute.name &&
					!context.state.scope.get(value.name)
				) {
					warn(
						context.state.analysis.warnings,
						attribute,
						context.path,
						'global-event-reference',
						attribute.name
					);
				}
			}

			if (attribute.name === 'slot') {
				/** @type {import('#compiler').RegularElement | import('#compiler').SvelteElement | import('#compiler').Component | import('#compiler').SvelteComponent | import('#compiler').SvelteSelf | undefined} */
				validate_slot_attribute(context, attribute);
			}

			if (attribute.name === 'is' && context.state.options.namespace !== 'foreign') {
				warn(context.state.analysis.warnings, attribute, context.path, 'avoid-is');
			}

			const correct_name = react_attributes.get(attribute.name);
			if (correct_name) {
				warn(
					context.state.analysis.warnings,
					attribute,
					context.path,
					'invalid-html-attribute',
					attribute.name,
					correct_name
				);
			}

			validate_attribute_name(attribute, context);
		} else if (attribute.type === 'AnimateDirective') {
			const parent = context.path.at(-2);
			if (parent?.type !== 'EachBlock') {
				error(attribute, 'invalid-animation', 'no-each');
			} else if (!parent.key) {
				error(attribute, 'invalid-animation', 'each-key');
			} else if (
				parent.body.nodes.filter(
					(n) =>
						n.type !== 'Comment' &&
						n.type !== 'ConstTag' &&
						(n.type !== 'Text' || n.data.trim() !== '')
				).length > 1
			) {
				error(attribute, 'invalid-animation', 'child');
			}

			if (has_animate_directive) {
				error(attribute, 'duplicate-animation');
			} else {
				has_animate_directive = true;
			}
		} else if (attribute.type === 'TransitionDirective') {
			if ((attribute.outro && has_out_transition) || (attribute.intro && has_in_transition)) {
				/** @param {boolean} _in @param {boolean} _out */
				const type = (_in, _out) => (_in && _out ? 'transition' : _in ? 'in' : 'out');
				error(
					attribute,
					'duplicate-transition',
					type(has_in_transition, has_out_transition),
					type(attribute.intro, attribute.outro)
				);
			}

			has_in_transition = has_in_transition || attribute.intro;
			has_out_transition = has_out_transition || attribute.outro;
		} else if (attribute.type === 'OnDirective') {
			let has_passive_modifier = false;
			let conflicting_passive_modifier = '';
			for (const modifier of attribute.modifiers) {
				if (!EventModifiers.includes(modifier)) {
					error(attribute, 'invalid-event-modifier', EventModifiers);
				}
				if (modifier === 'passive') {
					has_passive_modifier = true;
				} else if (modifier === 'nonpassive' || modifier === 'preventDefault') {
					conflicting_passive_modifier = modifier;
				}
				if (has_passive_modifier && conflicting_passive_modifier) {
					error(
						attribute,
						'invalid-event-modifier-combination',
						'passive',
						conflicting_passive_modifier
					);
				}
			}
		}
	}
}

/**
 * @param {import('#compiler').Attribute} attribute
 * @param {import('zimmerframe').Context<import('#compiler').SvelteNode, import('./types.js').AnalysisState>} context
 */
function validate_attribute_name(attribute, context) {
	if (
		attribute.name.includes(':') &&
		!attribute.name.startsWith('xmlns:') &&
		!attribute.name.startsWith('xlink:') &&
		!attribute.name.startsWith('xml:')
	) {
		warn(context.state.analysis.warnings, attribute, context.path, 'illegal-attribute-character');
	}
}

/**
 * @param {import('zimmerframe').Context<import('#compiler').SvelteNode, import('./types.js').AnalysisState>} context
 * @param {import('#compiler').Attribute} attribute
 */
function validate_slot_attribute(context, attribute) {
	let owner = undefined;

	let i = context.path.length;
	while (i--) {
		const ancestor = context.path[i];
		if (
			!owner &&
			(ancestor.type === 'Component' ||
				ancestor.type === 'SvelteComponent' ||
				ancestor.type === 'SvelteSelf' ||
				ancestor.type === 'SvelteElement' ||
				(ancestor.type === 'RegularElement' && is_custom_element_node(ancestor)))
		) {
			owner = ancestor;
		}
	}

	if (owner) {
		if (!is_text_attribute(attribute)) {
			error(attribute, 'invalid-slot-attribute');
		}

		if (
			owner.type === 'Component' ||
			owner.type === 'SvelteComponent' ||
			owner.type === 'SvelteSelf'
		) {
			if (owner !== context.path.at(-2)) {
				error(attribute, 'invalid-slot-placement');
			}

			const name = attribute.value[0].data;

			if (context.state.component_slots.has(name)) {
				error(attribute, 'duplicate-slot-name', name, owner.name);
			}

			context.state.component_slots.add(name);

			if (name === 'default') {
				for (const node of owner.fragment.nodes) {
					if (node.type === 'Text' && regex_only_whitespaces.test(node.data)) {
						continue;
					}

					if (node.type === 'RegularElement' || node.type === 'SvelteFragment') {
						if (node.attributes.some((a) => a.type === 'Attribute' && a.name === 'slot')) {
							continue;
						}
					}

					error(node, 'invalid-default-slot-content');
				}
			}
		}
	} else {
		error(attribute, 'invalid-slot-placement');
	}
}

/**
 * @param {import('#compiler').Fragment | null | undefined} node
 * @param {import('zimmerframe').Context<import('#compiler').SvelteNode, import('./types.js').AnalysisState>} context
 */
function validate_block_not_empty(node, context) {
	if (!node) return;
	// Assumption: If the block has zero elements, someone's in the middle of typing it out,
	// so don't warn in that case because it would be distracting.
	if (node.nodes.length === 1 && node.nodes[0].type === 'Text' && !node.nodes[0].raw.trim()) {
		warn(context.state.analysis.warnings, node.nodes[0], context.path, 'empty-block');
	}
}

/**
 * @type {import('zimmerframe').Visitors<import('#compiler').SvelteNode, import('./types.js').AnalysisState>}
 */
const validation = {
	AssignmentExpression(node, context) {
		validate_assignment(node, node.left, context.state);
	},
	BindDirective(node, context) {
		validate_no_const_assignment(node, node.expression, context.state.scope, true);

		const assignee = node.expression;
		const left = object(assignee);

		if (left === null) {
			error(node, 'invalid-binding-expression');
		}

		if (
			assignee.type === 'Identifier' &&
			node.name !== 'this' // bind:this also works for regular variables
		) {
			const binding = context.state.scope.get(left.name);
			// reassignment
			if (
				!binding ||
				(binding.kind !== 'state' &&
					binding.kind !== 'frozen_state' &&
					binding.kind !== 'prop' &&
					binding.kind !== 'each' &&
					binding.kind !== 'store_sub' &&
					!binding.mutated)
			) {
				error(node.expression, 'invalid-binding-value');
			}

			if (binding.kind === 'derived') {
				error(node.expression, 'invalid-derived-binding');
			}

			if (context.state.analysis.runes && binding.kind === 'each') {
				error(node, 'invalid-each-assignment');
			}

			// TODO handle mutations of non-state/props in runes mode
		}

		const binding = context.state.scope.get(left.name);

		if (node.name === 'group') {
			if (!binding) {
				error(node, 'INTERNAL', 'Cannot find declaration for bind:group');
			}
		}

		if (binding?.kind === 'each' && binding.metadata?.inside_rest) {
			warn(
				context.state.analysis.warnings,
				binding.node,
				context.path,
				'invalid-rest-eachblock-binding',
				binding.node.name
			);
		}

		const parent = context.path.at(-1);

		if (
			parent?.type === 'RegularElement' ||
			parent?.type === 'SvelteElement' ||
			parent?.type === 'SvelteWindow' ||
			parent?.type === 'SvelteDocument' ||
			parent?.type === 'SvelteBody'
		) {
			if (context.state.options.namespace === 'foreign' && node.name !== 'this') {
				error(
					node,
					'invalid-binding',
					node.name,
					undefined,
					'. Foreign elements only support bind:this'
				);
			}

			if (node.name in binding_properties) {
				const property = binding_properties[node.name];
				if (property.valid_elements && !property.valid_elements.includes(parent.name)) {
					error(
						node,
						'invalid-binding',
						node.name,
						property.valid_elements.map((valid_element) => `<${valid_element}>`).join(', ')
					);
				}

				if (parent.name === 'input' && node.name !== 'this') {
					const type = /** @type {import('#compiler').Attribute | undefined} */ (
						parent.attributes.find((a) => a.type === 'Attribute' && a.name === 'type')
					);
					if (type && !is_text_attribute(type)) {
						if (node.name !== 'value' || type.value === true) {
							error(type, 'invalid-type-attribute');
						}
						return; // bind:value can handle dynamic `type` attributes
					}

					if (node.name === 'checked' && type?.value[0].data !== 'checkbox') {
						error(node, 'invalid-binding', node.name, '<input type="checkbox">');
					}

					if (node.name === 'files' && type?.value[0].data !== 'file') {
						error(node, 'invalid-binding', node.name, '<input type="file">');
					}
				}

				if (parent.name === 'select') {
					const multiple = parent.attributes.find(
						(a) =>
							a.type === 'Attribute' &&
							a.name === 'multiple' &&
							!is_text_attribute(a) &&
							a.value !== true
					);
					if (multiple) {
						error(multiple, 'invalid-multiple-attribute');
					}
				}

				if (node.name === 'offsetWidth' && SVGElements.includes(parent.name)) {
					error(
						node,
						'invalid-binding',
						node.name,
						`non-<svg> elements. Use 'clientWidth' for <svg> instead`
					);
				}

				if (ContentEditableBindings.includes(node.name)) {
					const contenteditable = /** @type {import('#compiler').Attribute} */ (
						parent.attributes.find((a) => a.type === 'Attribute' && a.name === 'contenteditable')
					);
					if (!contenteditable) {
						error(node, 'missing-contenteditable-attribute');
					} else if (!is_text_attribute(contenteditable) && contenteditable.value !== true) {
						error(contenteditable, 'dynamic-contenteditable-attribute');
					}
				}
			} else {
				const match = fuzzymatch(node.name, Object.keys(binding_properties));
				if (match) {
					const property = binding_properties[match];
					if (!property.valid_elements || property.valid_elements.includes(parent.name)) {
						error(node, 'invalid-binding', node.name, undefined, ` (did you mean '${match}'?)`);
					}
				}
				error(node, 'invalid-binding', node.name);
			}
		}
	},
	ExportDefaultDeclaration(node) {
		error(node, 'default-export');
	},
	ConstTag(node, context) {
		const parent = context.path.at(-1);
		const grand_parent = context.path.at(-2);
		if (
			parent?.type !== 'Fragment' ||
			(grand_parent?.type !== 'IfBlock' &&
				grand_parent?.type !== 'SvelteFragment' &&
				grand_parent?.type !== 'Component' &&
				grand_parent?.type !== 'SvelteComponent' &&
				grand_parent?.type !== 'EachBlock' &&
				grand_parent?.type !== 'AwaitBlock' &&
				grand_parent?.type !== 'SnippetBlock' &&
				((grand_parent?.type !== 'RegularElement' && grand_parent?.type !== 'SvelteElement') ||
					!grand_parent.attributes.some((a) => a.type === 'Attribute' && a.name === 'slot')))
		) {
			error(node, 'invalid-const-placement');
		}
	},
	ImportDeclaration(node, context) {
		if (node.source.value === 'svelte' && context.state.analysis.runes) {
			for (const specifier of node.specifiers) {
				if (specifier.type === 'ImportSpecifier') {
					if (
						specifier.imported.name === 'beforeUpdate' ||
						specifier.imported.name === 'afterUpdate'
					) {
						error(specifier, 'invalid-runes-mode-import', specifier.imported.name);
					}
				}
			}
		}
	},
	LetDirective(node, context) {
		const parent = context.path.at(-1);
		if (
			parent === undefined ||
			(parent.type !== 'Component' &&
				parent.type !== 'RegularElement' &&
				parent.type !== 'SlotElement' &&
				parent.type !== 'SvelteElement' &&
				parent.type !== 'SvelteComponent' &&
				parent.type !== 'SvelteSelf' &&
				parent.type !== 'SvelteFragment')
		) {
			error(node, 'invalid-let-directive-placement');
		}
	},
	RegularElement(node, context) {
		if (node.name === 'textarea' && node.fragment.nodes.length > 0) {
			for (const attribute of node.attributes) {
				if (attribute.type === 'Attribute' && attribute.name === 'value') {
					error(node, 'invalid-textarea-content');
				}
			}
		}

		const binding = context.state.scope.get(node.name);
		if (
			binding !== null &&
			binding.declaration_kind === 'import' &&
			binding.references.length === 0
		) {
			warn(
				context.state.analysis.warnings,
				node,
				context.path,
				'component-name-lowercase',
				node.name
			);
		}

		validate_element(node, context);

		if (context.state.parent_element) {
			if (!is_tag_valid_with_parent(node.name, context.state.parent_element)) {
				error(node, 'invalid-node-placement', `<${node.name}>`, context.state.parent_element);
			}
		}

		if (interactive_elements.has(node.name)) {
			const path = context.path;
			for (let parent of path) {
				if (
					parent.type === 'RegularElement' &&
					parent.name === node.name &&
					interactive_elements.has(parent.name)
				) {
					error(node, 'invalid-node-placement', `<${node.name}>`, parent.name);
				}
			}
		}

		if (disallowed_parapgraph_contents.includes(node.name)) {
			const path = context.path;
			for (let parent of path) {
				if (parent.type === 'RegularElement' && parent.name === 'p') {
					error(node, 'invalid-node-placement', `<${node.name}>`, parent.name);
				}
			}
		}

		context.next({
			...context.state,
			parent_element: node.name
		});
	},
	RenderTag(node, context) {
		const raw_args = unwrap_optional(node.expression).arguments;
		for (const arg of raw_args) {
			if (arg.type === 'SpreadElement') {
				error(arg, 'invalid-render-spread-argument');
			}
		}

		const callee = unwrap_optional(node.expression).callee;
		if (
			callee.type === 'MemberExpression' &&
			callee.property.type === 'Identifier' &&
			['bind', 'apply', 'call'].includes(callee.property.name)
		) {
			error(node, 'invalid-render-call');
		}

		const is_inside_textarea = context.path.find((n) => {
			return (
				n.type === 'SvelteElement' &&
				n.name === 'svelte:element' &&
				n.tag.type === 'Literal' &&
				n.tag.value === 'textarea'
			);
		});
		if (is_inside_textarea) {
			error(
				node,
				'invalid-tag-placement',
				'inside <textarea> or <svelte:element this="textarea">',
				'render'
			);
		}
	},
	IfBlock(node, context) {
		validate_block_not_empty(node.consequent, context);
		validate_block_not_empty(node.alternate, context);
	},
	EachBlock(node, context) {
		validate_block_not_empty(node.body, context);
		validate_block_not_empty(node.fallback, context);
	},
	AwaitBlock(node, context) {
		validate_block_not_empty(node.pending, context);
		validate_block_not_empty(node.then, context);
		validate_block_not_empty(node.catch, context);
	},
	KeyBlock(node, context) {
		validate_block_not_empty(node.fragment, context);
	},
	SnippetBlock(node, context) {
		validate_block_not_empty(node.body, context);

		if (node.expression.name !== 'children') return;

		const { path } = context;
		const parent = path.at(-2);
		if (!parent) return;
		if (
			parent.type === 'Component' ||
			parent.type === 'SvelteComponent' ||
			parent.type === 'SvelteSelf'
		) {
			if (
				parent.fragment.nodes.some(
					(node) => node.type !== 'SnippetBlock' && (node.type !== 'Text' || node.data.trim())
				)
			) {
				error(node, 'conflicting-children-snippet');
			}
		}
	},
	StyleDirective(node) {
		if (node.modifiers.length > 1 || (node.modifiers.length && node.modifiers[0] !== 'important')) {
			error(node, 'invalid-style-directive-modifier');
		}
	},
	SvelteHead(node) {
		const attribute = node.attributes[0];
		if (attribute) {
			error(attribute, 'illegal-svelte-head-attribute');
		}
	},
	SvelteElement(node, context) {
		validate_element(node, context);
		context.next({
			...context.state,
			parent_element: null
		});
	},
	SvelteFragment(node, context) {
		const parent = context.path.at(-2);
		if (parent?.type !== 'Component' && parent?.type !== 'SvelteComponent') {
			error(node, 'invalid-svelte-fragment-placement');
		}

		for (const attribute of node.attributes) {
			if (attribute.type === 'Attribute') {
				if (attribute.name === 'slot') {
					validate_slot_attribute(context, attribute);
				}
			} else if (attribute.type !== 'LetDirective') {
				error(attribute, 'invalid-svelte-fragment-attribute');
			}
		}
	},
	SlotElement(node) {
		for (const attribute of node.attributes) {
			if (attribute.type === 'Attribute') {
				if (attribute.name === 'name') {
					if (!is_text_attribute(attribute)) {
						error(attribute, 'invalid-slot-name', false);
					}
					const slot_name = attribute.value[0].data;
					if (slot_name === 'default') {
						error(attribute, 'invalid-slot-name', true);
					}
				}
			} else if (attribute.type !== 'SpreadAttribute' && attribute.type !== 'LetDirective') {
				error(attribute, 'invalid-slot-element-attribute');
			}
		}
	},
	Component: validate_component,
	SvelteComponent: validate_component,
	SvelteSelf: validate_component,
	Text(node, context) {
		if (!node.parent) return;
		if (context.state.parent_element && regex_not_whitespace.test(node.data)) {
			if (!is_tag_valid_with_parent('#text', context.state.parent_element)) {
				error(node, 'invalid-node-placement', 'Text node', context.state.parent_element);
			}
		}
	},
	TitleElement(node) {
		const attribute = node.attributes[0];
		if (attribute) {
			error(attribute, 'illegal-title-attribute');
		}

		const child = node.fragment.nodes.find((n) => n.type !== 'Text' && n.type !== 'ExpressionTag');
		if (child) {
			error(child, 'invalid-title-content');
		}
	},
	UpdateExpression(node, context) {
		validate_assignment(node, node.argument, context.state);
	},
	ExpressionTag(node, context) {
		if (!node.parent) return;
		if (context.state.parent_element) {
			if (!is_tag_valid_with_parent('#text', context.state.parent_element)) {
				error(node, 'invalid-node-placement', '{expression}', context.state.parent_element);
			}
		}
	}
};

export const validation_legacy = merge(validation, a11y_validators, {
	VariableDeclarator(node, { state }) {
		ensure_no_module_import_conflict(node, state);

		if (node.init?.type !== 'CallExpression') return;

		const callee = node.init.callee;
		if (
			callee.type !== 'Identifier' ||
			(callee.name !== '$state' && callee.name !== '$derived' && callee.name !== '$props')
		) {
			return;
		}

		if (state.scope.get(callee.name)?.kind !== 'store_sub') {
			error(node.init, 'invalid-rune-usage', callee.name);
		}
	},
	AssignmentExpression(node, { state, path }) {
		const parent = path.at(-1);
		if (parent && parent.type === 'ConstTag') return;
		validate_assignment(node, node.left, state);
	},
	LabeledStatement(node, { path, state }) {
		if (
			node.label.name === '$' &&
			(state.ast_type !== 'instance' ||
				/** @type {import('#compiler').SvelteNode} */ (path.at(-1)).type !== 'Program')
		) {
			warn(state.analysis.warnings, node, path, 'no-reactive-declaration');
		}
	},
	UpdateExpression(node, { state }) {
		validate_assignment(node, node.argument, state);
	}
});

/**
 *
 * @param {import('estree').Node} node
 * @param {import('../scope').Scope} scope
 * @param {string} name
 */
function validate_export(node, scope, name) {
	const binding = scope.get(name);
	if (!binding) return;

	if (binding.kind === 'derived') {
		error(node, 'invalid-derived-export');
	}

	if ((binding.kind === 'state' || binding.kind === 'frozen_state') && binding.reassigned) {
		error(node, 'invalid-state-export');
	}
}

/**
 * @param {import('estree').CallExpression} node
 * @param {Scope} scope
 * @param {import('#compiler').SvelteNode[]} path
 * @returns
 */
function validate_call_expression(node, scope, path) {
	const rune = get_rune(node, scope);
	if (rune === null) return;

	const parent = /** @type {import('#compiler').SvelteNode} */ (get_parent(path, -1));

	if (rune === '$props') {
		if (parent.type === 'VariableDeclarator') return;
		error(node, 'invalid-props-location');
	}

	if (rune === '$state' || rune === '$derived' || rune === '$derived.by') {
		if (parent.type === 'VariableDeclarator') return;
		if (parent.type === 'PropertyDefinition' && !parent.static && !parent.computed) return;
		error(node, 'invalid-state-location', rune);
	}

	if (rune === '$effect' || rune === '$effect.pre') {
		if (parent.type !== 'ExpressionStatement') {
			error(node, 'invalid-effect-location');
		}

		if (node.arguments.length !== 1) {
			error(node, 'invalid-rune-args-length', rune, [1]);
		}
	}

	if (rune === '$effect.active') {
		if (node.arguments.length !== 0) {
			error(node, 'invalid-rune-args-length', rune, [0]);
		}
	}

	if (rune === '$effect.root') {
		if (node.arguments.length !== 1) {
			error(node, 'invalid-rune-args-length', rune, [1]);
		}
	}

	if (rune === '$inspect') {
		if (node.arguments.length < 1) {
			error(node, 'invalid-rune-args-length', rune, [1, 'more']);
		}
	}

	if (rune === '$inspect().with') {
		if (node.arguments.length !== 1) {
			error(node, 'invalid-rune-args-length', rune, [1]);
		}
	}
}

/**
 * @param {import('estree').VariableDeclarator} node
 * @param {import('./types.js').AnalysisState} state
 */
function ensure_no_module_import_conflict(node, state) {
	const ids = extract_identifiers(node.id);
	for (const id of ids) {
		if (
			state.scope === state.analysis.instance.scope &&
			state.analysis.module.scope.get(id.name)?.declaration_kind === 'import'
		) {
			error(node.id, 'illegal-variable-declaration');
		}
	}
}

/**
 * @type {import('zimmerframe').Visitors<import('#compiler').SvelteNode, import('./types.js').AnalysisState>}
 */
export const validation_runes_js = {
	ExportSpecifier(node, { state }) {
		validate_export(node, state.scope, node.local.name);
	},
	ExportNamedDeclaration(node, { state, next }) {
		if (node.declaration?.type !== 'VariableDeclaration') return;

		// visit children, so bindings are correctly initialised
		next();

		for (const declarator of node.declaration.declarations) {
			for (const id of extract_identifiers(declarator.id)) {
				validate_export(node, state.scope, id.name);
			}
		}
	},
	CallExpression(node, { state, path }) {
		validate_call_expression(node, state.scope, path);
	},
	VariableDeclarator(node, { state }) {
		const init = node.init;
		const rune = get_rune(init, state.scope);

		if (rune === null) return;

		const args = /** @type {import('estree').CallExpression} */ (init).arguments;

		if ((rune === '$derived' || rune === '$derived.by') && args.length !== 1) {
			error(node, 'invalid-rune-args-length', rune, [1]);
		} else if (rune === '$state' && args.length > 1) {
			error(node, 'invalid-rune-args-length', rune, [0, 1]);
		} else if (rune === '$props') {
			error(node, 'invalid-props-location');
		}
	},
	AssignmentExpression(node, { state }) {
		validate_assignment(node, node.left, state);
	},
	UpdateExpression(node, { state }) {
		validate_assignment(node, node.argument, state);
	},
	ClassBody(node, context) {
		/** @type {string[]} */
		const private_derived_state = [];

		for (const definition of node.body) {
			if (
				definition.type === 'PropertyDefinition' &&
				definition.key.type === 'PrivateIdentifier' &&
				definition.value?.type === 'CallExpression'
			) {
				const rune = get_rune(definition.value, context.state.scope);
				if (rune === '$derived' || rune === '$derived.by') {
					private_derived_state.push(definition.key.name);
				}
			}
		}

		context.next({
			...context.state,
			private_derived_state
		});
	},
	ClassDeclaration(node, context) {
		// In modules, we allow top-level module scope only, in components, we allow the component scope,
		// which is function_depth of 1. With the exception of `new class` which is also not allowed at
		// component scope level either.
		const allowed_depth = context.state.ast_type === 'module' ? 0 : 1;

		if (context.state.scope.function_depth > allowed_depth) {
			warn(context.state.analysis.warnings, node, context.path, 'avoid-nested-class');
		}
	},
	NewExpression(node, context) {
		if (node.callee.type === 'ClassExpression' && context.state.scope.function_depth > 0) {
			warn(context.state.analysis.warnings, node, context.path, 'avoid-inline-class');
		}
	}
};

/**
 * @param {import('../../errors.js').NodeLike} node
 * @param {import('estree').Pattern | import('estree').Expression} argument
 * @param {Scope} scope
 * @param {boolean} is_binding
 */
function validate_no_const_assignment(node, argument, scope, is_binding) {
	if (argument.type === 'ArrayPattern') {
		for (const element of argument.elements) {
			if (element) {
				validate_no_const_assignment(node, element, scope, is_binding);
			}
		}
	} else if (argument.type === 'ObjectPattern') {
		for (const element of argument.properties) {
			if (element.type === 'Property') {
				validate_no_const_assignment(node, element.value, scope, is_binding);
			}
		}
	} else if (argument.type === 'Identifier') {
		const binding = scope.get(argument.name);
		if (binding?.declaration_kind === 'const' && binding.kind !== 'each') {
			error(
				node,
				'invalid-const-assignment',
				is_binding,
				// This takes advantage of the fact that we don't assign initial for let directives and then/catch variables.
				// If we start doing that, we need another property on the binding to differentiate, or give up on the more precise error message.
				binding.kind !== 'state' &&
					binding.kind !== 'frozen_state' &&
					(binding.kind !== 'normal' || !binding.initial)
			);
		}
	}
}

/**
 * @param {import('estree').AssignmentExpression | import('estree').UpdateExpression} node
 * @param {import('estree').Pattern | import('estree').Expression} argument
 * @param {import('./types.js').AnalysisState} state
 */
function validate_assignment(node, argument, state) {
	validate_no_const_assignment(node, argument, state.scope, false);

	if (state.analysis.runes && argument.type === 'Identifier') {
		const binding = state.scope.get(argument.name);
		if (binding?.kind === 'derived') {
			error(node, 'invalid-derived-assignment');
		}

		if (binding?.kind === 'each') {
			error(node, 'invalid-each-assignment');
		}
	}

	let object = /** @type {import('estree').Expression | import('estree').Super} */ (argument);

	/** @type {import('estree').Expression | import('estree').PrivateIdentifier | null} */
	let property = null;

	while (object.type === 'MemberExpression') {
		property = object.property;
		object = object.object;
	}

	if (object.type === 'ThisExpression' && property?.type === 'PrivateIdentifier') {
		if (state.private_derived_state.includes(property.name)) {
			error(node, 'invalid-derived-assignment');
		}
	}
}

export const validation_runes = merge(validation, a11y_validators, {
	LabeledStatement(node, { path }) {
		if (node.label.name !== '$' || path.at(-1)?.type !== 'Program') return;
		error(node, 'invalid-legacy-reactive-statement');
	},
	ExportNamedDeclaration(node, { state, next }) {
		if (state.ast_type === 'module') {
			if (node.declaration?.type !== 'VariableDeclaration') return;

			// visit children, so bindings are correctly initialised
			next();

			for (const declarator of node.declaration.declarations) {
				for (const id of extract_identifiers(declarator.id)) {
					validate_export(node, state.scope, id.name);
				}
			}
		} else {
			if (node.declaration?.type !== 'VariableDeclaration') return;
			if (node.declaration.kind !== 'let') return;
			if (state.analysis.instance.scope !== state.scope) return;
			error(node, 'invalid-legacy-export');
		}
	},
	ExportSpecifier(node, { state }) {
		if (state.ast_type === 'module') {
			validate_export(node, state.scope, node.local.name);
		}
	},
	CallExpression(node, { state, path }) {
		validate_call_expression(node, state.scope, path);
	},
	EachBlock(node, { next, state }) {
		const context = node.context;
		if (
			context.type === 'Identifier' &&
			(context.name === '$state' || context.name === '$derived')
		) {
			error(node, 'invalid-state-location', context.name);
		}
		next({ ...state });
	},
	VariableDeclarator(node, { state, path }) {
		ensure_no_module_import_conflict(node, state);

		const init = node.init;
		const rune = get_rune(init, state.scope);

		if (rune === null) {
			if (init?.type === 'Identifier' && init.name === '$props' && !state.scope.get('props')) {
				warn(state.analysis.warnings, node, path, 'invalid-props-declaration');
			}
			return;
		}

		const args = /** @type {import('estree').CallExpression} */ (init).arguments;

		// TODO some of this is duplicated with above, seems off
		if ((rune === '$derived' || rune === '$derived.by') && args.length !== 1) {
			error(node, 'invalid-rune-args-length', rune, [1]);
		} else if (rune === '$state' && args.length > 1) {
			error(node, 'invalid-rune-args-length', rune, [0, 1]);
		} else if (rune === '$props') {
			if (state.has_props_rune) {
				error(node, 'duplicate-props-rune');
			}

			state.has_props_rune = true;

			if (args.length > 0) {
				error(node, 'invalid-rune-args-length', '$props', [0]);
			}

			if (node.id.type !== 'ObjectPattern') {
				error(node, 'invalid-props-id');
			}

			if (state.scope !== state.analysis.instance.scope) {
				error(node, 'invalid-props-location');
			}

			for (const property of node.id.properties) {
				if (property.type === 'Property') {
					if (property.computed) {
						error(property, 'invalid-props-pattern');
					}

					const value =
						property.value.type === 'AssignmentPattern' ? property.value.left : property.value;

					if (value.type !== 'Identifier') {
						error(property, 'invalid-props-pattern');
					}
				}
			}
		}

		if (rune === '$derived') {
			const arg = args[0];
			if (
				arg.type === 'CallExpression' &&
				(arg.callee.type === 'ArrowFunctionExpression' || arg.callee.type === 'FunctionExpression')
			) {
				warn(state.analysis.warnings, node, path, 'derived-iife');
			}
		}
	},
	// TODO this is a code smell. need to refactor this stuff
	ClassBody: validation_runes_js.ClassBody,
	ClassDeclaration: validation_runes_js.ClassDeclaration,
	NewExpression: validation_runes_js.NewExpression
});
