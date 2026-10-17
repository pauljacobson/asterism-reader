<?php
namespace OAuth2\Storage { interface AuthorizationCodeInterface { public function getAuthorizationCode($code); public function setAuthorizationCode($code,$client_id,$user_id,$redirect_uri,$expires,$scope=null); public function expireAuthorizationCode($code); } }
namespace {
$codes=[];$meta=[];
function add_action(...$args){} function register_taxonomy(...$args){} function register_term_meta(...$args){}
function get_term_by($field,$code,$tax){global $codes;return isset($codes[$code])?(object)['term_id'=>$codes[$code]]:false;}
function wp_insert_term($code,$tax){global $codes;$id=count($codes)+1;$codes[$code]=$id;return ['term_id'=>$id];}
function is_wp_error($value){return false;}
function add_term_meta($id,$key,$value){global $meta;$meta[$id][$key]=$value;}
function get_term_meta($id,$key,$single){global $meta;return $meta[$id][$key]??'';}
function wp_delete_term($id,$tax){global $codes,$meta;foreach($codes as $code=>$value){if($value===$id)unset($codes[$code]);}unset($meta[$id]);}
if ( empty( $argv[1] ) ) { throw new \Exception('Supply the path to the patched class file.'); }
require $argv[1];
$storage=new \Enable_Mastodon_Apps\OAuth2\Authorization_Code_Storage();
$challenge=rtrim(strtr(base64_encode(hash('sha256',str_repeat('v',43),true)),'+/','-_'),'=');
$storage->setAuthorizationCode('code','client',1,'https://reader.example/callback',time()+300,'read',null,$challenge,'S256');
$result=$storage->getAuthorizationCode('code');
if($result['code_challenge']!==$challenge || $result['code_challenge_method']!=='S256')throw new \Exception('PKCE metadata lost');
$storage->expireAuthorizationCode('code');if($storage->getAuthorizationCode('code')!==null)throw new \Exception('Code not consumed');
echo "PASS: PKCE metadata round-trip and code deletion with WordPress storage stubs\n";
}
