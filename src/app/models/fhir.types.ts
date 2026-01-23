/**
 * FHIR Resource Type Definitions
 * Based on FHIR R4 Specification
 */

export type ObservationStatus =
  | 'registered'
  | 'preliminary'
  | 'final'
  | 'amended'
  | 'corrected'
  | 'cancelled'
  | 'entered-in-error'
  | 'unknown';

export type DataAbsentReasonCode =
  | 'unknown'
  | 'asked-unknown'
  | 'temp'
  | 'not-asked'
  | 'asked-declined'
  | 'masked'
  | 'not-applicable'
  | 'unsupported'
  | 'as-text'
  | 'error'
  | 'not-a-number'
  | 'negative-infinity'
  | 'positive-infinity'
  | 'not-performed'
  | 'not-permitted';

export interface Coding {
  system?: string;
  version?: string;
  code?: string;
  display?: string;
  userSelected?: boolean;
}

export interface CodeableConcept {
  coding?: Coding[];
  text?: string;
}

export interface Reference {
  reference?: string;
  type?: string;
  identifier?: {
    use?: string;
    type?: CodeableConcept;
    system?: string;
    value?: string;
  };
  display?: string;
}

export interface Quantity {
  value?: number;
  comparator?: '<' | '<=' | '>=' | '>';
  unit?: string;
  system?: string;
  code?: string;
}

export interface SimpleQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface Range {
  low?: SimpleQuantity;
  high?: SimpleQuantity;
}

export interface ReferenceRange {
  low?: SimpleQuantity;
  high?: SimpleQuantity;
  type?: CodeableConcept;
  appliesTo?: CodeableConcept[];
  age?: Range;
  text?: string;
}

export interface Period {
  start?: string;
  end?: string;
}

export interface Timing {
  event?: string[];
  repeat?: {
    bounds?: Period | Range;
    count?: number;
    duration?: number;
    durationUnit?: string;
    frequency?: number;
    period?: number;
    periodUnit?: string;
  };
  code?: CodeableConcept;
}

export interface Meta {
  versionId?: string;
  lastUpdated?: string;
  source?: string;
  profile?: string[];
  security?: Coding[];
  tag?: Coding[];
}

export interface ObservationComponent {
  code: CodeableConcept;
  valueQuantity?: Quantity;
  valueCodeableConcept?: CodeableConcept;
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueRange?: Range;
  valueRatio?: {
    numerator?: Quantity;
    denominator?: Quantity;
  };
  valueSampledData?: any;
  valueTime?: string;
  valueDateTime?: string;
  valuePeriod?: Period;
  dataAbsentReason?: CodeableConcept;
  interpretation?: CodeableConcept[];
  referenceRange?: ReferenceRange[];
}

export interface Observation {
  resourceType: 'Observation';
  id?: string;
  meta?: Meta;
  implicitRules?: string;
  language?: string;
  text?: {
    status?: string;
    div?: string;
  };
  contained?: any[];
  extension?: any[];
  modifierExtension?: any[];
  identifier?: Array<{
    use?: string;
    type?: CodeableConcept;
    system?: string;
    value?: string;
    period?: Period;
    assigner?: Reference;
  }>;
  basedOn?: Reference[];
  partOf?: Reference[];
  status: ObservationStatus;
  category?: CodeableConcept[];
  code: CodeableConcept;
  subject?: Reference;
  focus?: Reference[];
  encounter?: Reference;
  effectiveDateTime?: string;
  effectivePeriod?: Period;
  effectiveTiming?: Timing;
  effectiveInstant?: string;
  issued?: string;
  performer?: Reference[];
  valueQuantity?: Quantity;
  valueCodeableConcept?: CodeableConcept;
  valueString?: string;
  valueBoolean?: boolean;
  valueInteger?: number;
  valueRange?: Range;
  valueRatio?: {
    numerator?: Quantity;
    denominator?: Quantity;
  };
  valueSampledData?: any;
  valueTime?: string;
  valueDateTime?: string;
  valuePeriod?: Period;
  dataAbsentReason?: CodeableConcept;
  interpretation?: CodeableConcept[];
  note?: Array<{
    authorReference?: Reference;
    authorString?: string;
    time?: string;
    text: string;
  }>;
  bodySite?: CodeableConcept;
  method?: CodeableConcept;
  specimen?: Reference;
  device?: Reference;
  referenceRange?: ReferenceRange[];
  hasMember?: Reference[];
  derivedFrom?: Reference[];
  component?: ObservationComponent[];
  organizer?: boolean;
  triggeredBy?: Array<{
    observation: Reference;
    type: 'reflex' | 'repeat' | 're-run';
    reason?: CodeableConcept;
  }>;
}

export interface BundleEntry {
  fullUrl?: string;
  resource?: Observation | any;
  search?: any;
  request?: any;
  response?: any;
}

export interface Bundle {
  resourceType: 'Bundle';
  id?: string;
  meta?: Meta;
  implicitRules?: string;
  language?: string;
  identifier?: {
    use?: string;
    system?: string;
    value?: string;
  };
  type:
    | 'document'
    | 'message'
    | 'transaction'
    | 'transaction-response'
    | 'batch'
    | 'batch-response'
    | 'history'
    | 'searchset'
    | 'collection';
  timestamp?: string;
  total?: number;
  link?: Array<{
    relation: string;
    url: string;
  }>;
  entry?: BundleEntry[];
  signature?: any;
}

export interface LaboratoryParameter {
  name: string;
  loincCode: string;
  units: {
    unit: string;
    system: string;
    code: string;
    typicalRange?: { low: number; high: number };
    criticalLow?: number;
    criticalHigh?: number;
  }[];
  altUnits?: {
    unit: string;
    system: string;
    code: string;
    typicalRange?: { low: number; high: number };
    criticalLow?: number;
    criticalHigh?: number;
  }[];
  requiresFasting?: boolean;
  specimenType?: string[];
}
