import { Map } from 'immutable';

import * as C from '../../util/Consts';
import * as Err from '../../util/Errors';
import * as E from '../Expressions';

import { bool } from './Helpers';
import { regularFunctions, SPARQLFunction, specialFunctions } from './index';

type Term = E.TermExpression;
type Result = Promise<E.TermExpression>;

// Special Functions ----------------------------------------------------------
/*
 * Special Functions are those that don't really fit in sensible categories and
 * have extremely heterogeneous signatures that make them impossible to abstract
 * over. They are small in number, and their behaviour is often complex and open
 * for multiple correct implementations with different trade-offs.
 *
 * Due to their varying nature, they need all available information present
 * during evaluation. This reflects in the signature of the apply() method.
 *
 * They need access to an evaluator to be able to even implement their logic.
 * Especially relevant for IF, and the logical connectives.
 *
 * They can have both sync and async implementations, and both would make sense
 * in some contexts.
 */
export class SpecialFunctionAsync implements SPARQLFunction<E.SpecialApplication> {
  functionClass: 'special' = 'special';
  arity: number;
  apply: E.SpecialApplication;

  constructor(public operator: C.SpecialOperator, definition: SpecialDefinition) {
    this.arity = definition.arity;
    this.apply = definition.apply;
  }
}

// BOUND ----------------------------------------------------------------------
const bound = {
  arity: 1,
  async apply({ args, mapping }: E.EvalContext): Result {
    const variable = args[0] as E.VariableExpression;
    if (variable.expressionType !== E.ExpressionType.Variable) {
      throw new Err.InvalidArgumentTypes(args, C.SpecialOperator.BOUND);
    }
    const val = mapping.has(variable.name) && !!mapping.get(variable.name);
    return bool(val);
  },
};

// IF -------------------------------------------------------------------------
const ifSPARQL = {
  arity: 3,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    const valFirst = await evaluate(args[0], mapping);
    const ebv = valFirst.coerceEBV();
    return (ebv)
      ? evaluate(args[1], mapping)
      : evaluate(args[2], mapping);
  },
};

// COALESCE -------------------------------------------------------------------
const coalesce = {
  arity: Infinity,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    const errors: Error[] = [];
    for (const expr of args) {
      try {
        return await evaluate(expr, mapping);
      } catch (err) {
        errors.push(err);
      }
    }
    throw new Err.CoalesceError(errors);
  },
};

// logical-or (||) ------------------------------------------------------------
// https://www.w3.org/TR/sparql11-query/#func-logical-or
const logicalOr = {
  arity: 2,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    const [leftExpr, rightExpr] = args;
    try {
      const leftTerm = await evaluate(leftExpr, mapping);
      const left = leftTerm.coerceEBV();
      if (left) { return bool(true); }
      const rightTerm = await evaluate(rightExpr, mapping);
      const right = rightTerm.coerceEBV();
      return bool(right);
    } catch (leftErr) {
      const rightTerm = await evaluate(rightExpr, mapping);
      const right = rightTerm.coerceEBV();
      if (!right) { throw leftErr; }
      return bool(true);
    }
  },
};

// logical-and (&&) -----------------------------------------------------------
// https://www.w3.org/TR/sparql11-query/#func-logical-and
const logicalAnd = {
  arity: 2,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    const [leftExpr, rightExpr] = args;
    try {
      const leftTerm = await evaluate(leftExpr, mapping);
      const left = leftTerm.coerceEBV();
      if (!left) { return bool(false); }
      const rightTerm = await evaluate(rightExpr, mapping);
      const right = rightTerm.coerceEBV();
      return bool(right);
    } catch (leftErr) {
      const rightTerm = await evaluate(rightExpr, mapping);
      const right = rightTerm.coerceEBV();
      if (right) { throw leftErr; }
      return bool(false);
    }
  },
};

// sameTerm -------------------------------------------------------------------
const sameTerm = {
  arity: 2,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    if (args.length !== 2) { throw new Err.InvalidArity(args, C.SpecialOperator.SAME_TERM); }
    const [leftExpr, rightExpr] = args.map((a) => evaluate(a, mapping));
    const left = await leftExpr;
    const right = await rightExpr;
    return bool(left.toRDF().equals(right.toRDF()));
  },
};

// IN -------------------------------------------------------------------------
const inSPARQL = {
  arity: Infinity,
  async apply({ args, mapping, evaluate }: E.EvalContext): Result {
    if (args.length < 1) { throw new Err.InvalidArity(args, C.SpecialOperator.IN); }
    const [leftExpr, ...remaining] = args;
    const left = await evaluate(leftExpr, mapping);
    return inRecursive(left, { args: remaining, mapping, evaluate }, []);
  },
};

async function inRecursive(
  needle: Term,
  { args, mapping, evaluate }: E.EvalContext,
  results: Array<Error | false>,
): Result {

  if (args.length === 0) {
    const noErrors = results.every((v) => !v);
    return (noErrors) ? bool(false) : Promise.reject(new Err.InError(results));
  }

  try {
    const next = await evaluate(args.shift(), mapping);
    const isEqual = regularFunctions.get(C.RegularOperator.EQUAL);
    if (isEqual.apply([needle, next])) {
      return bool(true);
    } else {
      inRecursive(needle, { args, mapping, evaluate }, [...results, false]);
    }
  } catch (err) {
    return inRecursive(needle, { args, mapping, evaluate }, [...results, err]);
  }
}

// NOT IN ---------------------------------------------------------------------
const notInSPARQL = {
  arity: Infinity,
  async apply(context: E.EvalContext): Result {
    const _in = specialFunctions.get(C.SpecialOperator.IN);
    const isIn = await _in.apply(context);
    return bool(!(isIn as E.BooleanLiteral).typedValue);
  },
};

// ----------------------------------------------------------------------------
// Wrap these declarations into functions
// ----------------------------------------------------------------------------

export type SpecialDefinition = {
  arity: number;
  apply: E.SpecialApplication;
};

const _specialDefinitions: { [key in C.SpecialOperator]: SpecialDefinition } = {
  // --------------------------------------------------------------------------
  // Functional Forms
  // https://www.w3.org/TR/sparql11-query/#func-forms
  // --------------------------------------------------------------------------
  'bound': bound,
  'if': ifSPARQL,
  'coalesce': coalesce,
  '&&': logicalAnd,
  '||': logicalOr,
  'sameterm': sameTerm,
  'in': inSPARQL,
  'notin': notInSPARQL,
};

export const specialDefinitions = Map<C.SpecialOperator, SpecialDefinition>(_specialDefinitions);